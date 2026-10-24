import { Logger } from '@nestjs/common';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import type { JWTPayload } from 'jose';
import { encodeCompactJws } from './jws';
import type {
  KeyMetadata,
  KeyProvider,
  PublicJwk,
  RotationMode,
  RotationResult,
} from './key-provider';

interface KeyEntry {
  kid: string;
  status: 'active' | 'retiring';
  publicJwk: PublicJwk;
  createdAt: string;
  /** For retiring keys: when the key leaves JWKS. */
  retireAt?: string;
}

const STATE_FILE = 'keys.json';

/**
 * DEV-ONLY key provider (plan D9). RSA-2048 private keys live as PKCS8 PEM files
 * in `KEY_LOCAL_DIR` (git-ignored, mode 0600); state (kid/status/public JWK) in
 * `keys.json`. Private keys never go to MongoDB (INV-19). A retiring key's
 * private file is deleted at rotation time — only its public JWK is kept.
 *
 * Concurrency (DEBT-145): only `init` and `rotate` write `keys.json`; every `rotate` runs inside an
 * in-process promise-chain mutex, and the read paths (`getPublicKeys`, `listKeys`, `getSigningKey`)
 * never write. The mutex holds within ONE process only (`KEY_PROVIDER` is a DI singleton): two
 * processes sharing `KEY_LOCAL_DIR` can still race (single dev node only; multi-node needs the KMS
 * provider, plan B7.3 / DEBT-159).
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly logger = new Logger(LocalKeyProvider.name);
  /** Tail of the rotate mutex; a failed rotate must not block the next one. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  /** Create the directory and a first active key if none exists. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entries = await this.readState();
    if (!entries.some((e) => e.status === 'active')) {
      entries.push(await this.createKey());
      await this.writeState(entries);
    }
    await this.warnOrphanPems(entries);
  }

  /**
   * DEBT-163: a `<kid>.pem` not referenced by `keys.json` (e.g. an emergency rotate that died after
   * `writeState` but before `removePem` left the compromised key on disk) is reported once at WARN
   * (kids only, no path/content) and NEVER deleted: in a shared dir it may be another process's
   * just-created PEM. A `readdir` failure only warns; it never fails `init`.
   */
  private async warnOrphanPems(entries: KeyEntry[]): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      this.logger.warn('Could not list the key directory to check for orphan private keys');
      return;
    }
    const known = new Set(entries.map((e) => e.kid));
    const orphans = files
      .filter((f) => f.endsWith('.pem'))
      .map((f) => f.slice(0, -'.pem'.length))
      .filter((kid) => !known.has(kid));
    if (orphans.length) {
      this.logger.warn(
        `Private key file(s) not in ${STATE_FILE} (orphans, not deleted): ${orphans.join(', ')}`,
      );
    }
  }

  /** RS256 = RSASSA-PKCS1-v1_5 + SHA-256 (the `node:crypto` default padding for RSA keys). */
  async signJwt(header: { typ: string }, payload: JWTPayload): Promise<string> {
    const { kid, privateKey } = await this.getSigningKey();
    return encodeCompactJws({ alg: 'RS256', kid, typ: header.typ }, payload, async (input) =>
      sign('sha256', input, privateKey),
    );
  }

  /**
   * Dev/test only — NOT part of `KeyProvider` (run 53): tests use it to forge tokens with the real
   * key. Production code signs through `signJwt` and never sees a private key.
   */
  async getSigningKey(): Promise<{ kid: string; privateKey: KeyObject }> {
    try {
      return await this.loadSigningKey();
    } catch (err) {
      // A normal rotate deletes the old PEM right after persisting the new state: a reader holding
      // the previous state sees ENOENT. Re-read the state once; a second failure is real.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      return this.loadSigningKey();
    }
  }

  private async loadSigningKey(): Promise<{ kid: string; privateKey: KeyObject }> {
    const active = (await this.readState()).find((e) => e.status === 'active');
    if (!active) {
      throw new Error('No active signing key');
    }
    const pem = await readFile(this.pemPath(active.kid), 'utf8');
    return { kid: active.kid, privateKey: createPrivateKey(pem) };
  }

  /** Read-only (DEBT-145): expired retiring keys are filtered here and pruned by `rotate`. */
  async getPublicKeys(): Promise<PublicJwk[]> {
    return (await this.liveEntries()).map((e) => e.publicJwk);
  }

  async listKeys(): Promise<KeyMetadata[]> {
    return (await this.liveEntries()).map((e) => ({
      kid: e.kid,
      alg: e.publicJwk.alg,
      status: e.status,
      createdAt: e.createdAt,
      retireAt: e.retireAt ?? null,
    }));
  }

  private async liveEntries(): Promise<KeyEntry[]> {
    return LocalKeyProvider.live(await this.readState(), Date.now());
  }

  private static live(entries: KeyEntry[], now: number): KeyEntry[] {
    return entries.filter((e) => e.status === 'active' || Date.parse(e.retireAt ?? '') > now);
  }

  /** Serialised (DEBT-145): every rotation sees the state the previous one wrote. */
  rotate(mode: RotationMode, retainSec: number): Promise<RotationResult> {
    const run = this.chain.then(() => this.rotateExclusive(mode, retainSec));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async rotateExclusive(mode: RotationMode, retainSec: number): Promise<RotationResult> {
    const entries = await this.readState();
    const old = entries.find((e) => e.status === 'active');
    const fresh = await this.createKey();

    // DEBT-007: PERSIST the new state (atomically) BEFORE deleting any old private PEM. If the
    // write fails, `rotate` rejects but the OLD key is still active in `keys.json` AND its PEM is
    // still on disk, so `getSigningKey()` keeps working (no DoS). Deleting PEMs first would leave
    // `keys.json` pointing at a missing file on a write failure. The freshly-written PEM that never
    // made it into state is a harmless orphan (never used to sign); we do NOT garbage-collect
    // orphans here — two processes sharing the key dir (rolling deploy) would delete each other's
    // just-created PEM before the state write (re-creating the very bug this fixes).
    let next: KeyEntry[];
    if (mode === 'emergency') {
      next = [fresh]; // drop the old key and every retiring key (spec §6.4)
    } else {
      const retireAt = new Date(Date.now() + retainSec * 1000).toISOString();
      // Prune expired retiring keys here, inside the mutex (their PEMs are already gone).
      next = [
        ...LocalKeyProvider.live(entries, Date.now()).map((e) =>
          e === old ? { ...e, status: 'retiring' as const, retireAt } : e,
        ),
        fresh,
      ];
    }
    await this.writeState(next);

    // State is durable now; remove private PEMs that are no longer needed (best-effort). An `rm`
    // failure does NOT fail the rotation (the key is already retired/dropped in state and will not
    // sign). For emergency the key is compromised, so a failure to delete is logged at ERROR; for a
    // normal rotation it is a WARN. Only the kid is logged, never the PEM path contents.
    if (mode === 'emergency') {
      await Promise.all(entries.map((e) => this.removePem(e.kid, 'emergency')));
    } else if (old) {
      await this.removePem(old.kid, 'normal'); // verify-only from now on
    }

    return { newKid: fresh.kid, oldKid: old?.kid ?? null, mode };
  }

  /** Delete a private PEM best-effort; log (never throw) on failure so rotation stays successful. */
  private async removePem(kid: string, mode: RotationMode): Promise<void> {
    try {
      await rm(this.pemPath(kid), { force: true });
    } catch {
      const msg = `Failed to delete retired private key ${kid} after ${mode} rotation`;
      if (mode === 'emergency') {
        this.logger.error(msg); // compromised key may linger on disk — must be visible
      } else {
        this.logger.warn(msg);
      }
    }
  }

  private async createKey(): Promise<KeyEntry> {
    const kid = randomUUID();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    await writeFile(this.pemPath(kid), pem, { mode: 0o600 });

    const { n, e } = createPublicKey(privateKey).export({ format: 'jwk' });
    return {
      kid,
      status: 'active',
      publicJwk: { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n: n as string, e: e as string },
      createdAt: new Date().toISOString(),
    };
  }

  private pemPath(kid: string): string {
    return join(this.dir, `${kid}.pem`);
  }

  private async readState(): Promise<KeyEntry[]> {
    try {
      return JSON.parse(await readFile(join(this.dir, STATE_FILE), 'utf8')) as KeyEntry[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  private async writeState(entries: KeyEntry[]): Promise<void> {
    // DEBT-007: atomic replace. Write to a uniquely-named temp file (so two processes sharing the
    // dir never collide), then rename over `keys.json` (atomic on the same filesystem). A crash mid
    // write leaves the old `keys.json` intact instead of a truncated/invalid JSON. If the rename
    // fails, remove the temp file best-effort and rethrow so `rotate`/`init` fail closed.
    const finalPath = join(this.dir, STATE_FILE);
    const tmpPath = join(this.dir, `${STATE_FILE}.${randomUUID()}.tmp`);
    try {
      // Inside the try so a mid-write failure (e.g. ENOSPC) also cleans up the partial temp file.
      await writeFile(tmpPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
      await this.atomicRename(tmpPath, finalPath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Rename `tmpPath` over `finalPath` (atomic on the same filesystem). Isolated so the DEBT-007
   * atomicity contract — a rename failure leaves the previous `keys.json` byte-intact — can be
   * exercised deterministically under ESM (named `fs/promises` imports are not spyable).
   */
  protected atomicRename(tmpPath: string, finalPath: string): Promise<void> {
    return rename(tmpPath, finalPath);
  }
}
