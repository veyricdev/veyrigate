import { createHmac } from "node:crypto";
import { writeSync } from "node:fs";
import { ADMIN_SEED_EMAIL, E2E_ADMIN_TOTP_SECRET, E2E_USER_EMAIL, E2E_USER_TOTP_SECRET } from "../../config/env";

/**
 * TOTP for the E2E suite (run 89 T6, D89.20): RFC 4226 HOTP + RFC 6238 TOTP (SHA-1, 30 s) on
 * `node:crypto` only, self-checked against the RFC vectors in `totp.spec.ts`. Never imported from
 * `be/` (the suite proves the IdP against an independent implementation). Secrets are the public
 * E2E fixtures of `config/env.ts`; no code or secret is ever logged.
 */

export const PERIOD_SEC = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("base32: invalid character");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(key: Buffer, counter: number, digits = 6, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, "0");
}

export const stepAt = (ms: number): number => Math.floor(ms / 1000 / PERIOD_SEC);

/** The 6-digit code of `step` for a base32 secret. */
export const totpAt = (secretB32: string, step: number): string => hotp(base32Decode(secretB32), step);

/** Registry of the TOTP seeds the suite knows: the seeded admin + `E2E_USER`, plus seeds read from `/account/mfa`. */
const secrets = new Map<string, string>([
  [ADMIN_SEED_EMAIL.toLowerCase(), E2E_ADMIN_TOTP_SECRET],
  [E2E_USER_EMAIL.toLowerCase(), E2E_USER_TOTP_SECRET],
]);
export const secretFor = (email: string): string | undefined => secrets.get(email.toLowerCase());
export const rememberSecret = (email: string, secretB32: string | undefined): void => {
  if (secretB32) secrets.set(email.toLowerCase(), secretB32);
  else secrets.delete(email.toLowerCase());
};

/**
 * Step allocator per secret (T6 AC2). The IdP accepts steps c-1..c+1 strictly above the last one
 * used (replay rule), so a burst of sign-ins gets 3 codes, then one per 30 s:
 *   next = max(last + 1, c - 1)   (c - 1 only while > 5 s are left in step c, else c: the IdP
 *                                   must still see it in its window when the form arrives)
 *   next > c + 1 => wait until 1 s into step next - 1.
 * Total wait is reported by `waitedMs()` (logged at the end of the suite).
 */
const lastStep = new Map<string, number>();
let waited = 0;
export const waitedMs = (): number => waited;
let codes = 0;
// AC2: total allocator wait of this worker, logged when the worker exits (end of the suite, or a
// worker restart after a failure). Synchronous write: nothing async runs in an `exit` handler.
process.once("exit", () => {
  if (codes > 0) writeSync(2, `totp allocator (worker ${process.pid}): ${codes} codes, waited ${Math.round(waited / 1000)} s\n`);
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function nextCode(secretB32: string, now: () => number = Date.now): Promise<string> {
  const t = now();
  const c = stepAt(t);
  const intoStep = (t / 1000) % PERIOD_SEC;
  const floor = intoStep < PERIOD_SEC - 5 ? c - 1 : c;
  const last = lastStep.get(secretB32);
  const next = Math.max(last === undefined ? floor : last + 1, floor);
  if (next > c + 1) {
    const until = (next - 1) * PERIOD_SEC * 1000 + 1000;
    const ms = Math.max(0, until - now());
    waited += ms;
    await sleep(ms);
  }
  lastStep.set(secretB32, next);
  codes++;
  return totpAt(secretB32, next);
}

/** The IdP refused a code we believed fresh (another process used the step, e.g. `E2E_REUSE=1`): skip past now. */
export function markStale(secretB32: string, now: () => number = Date.now): void {
  const c = stepAt(now());
  lastStep.set(secretB32, Math.max(lastStep.get(secretB32) ?? c, c + 1));
}

/** Bypass the allocator (the replay spec reuses an exact step on purpose). */
export function noteUsed(secretB32: string, step: number): void {
  lastStep.set(secretB32, Math.max(lastStep.get(secretB32) ?? step, step));
}
