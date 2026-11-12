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
import {
  RotationPendingError,
  type KeyMetadata,
  type KeyProvider,
  type KeyStatus,
  type PublicJwk,
  type RotationMode,
  type RotationResult,
} from './key-provider';

/**
 * One key in `keys.json`, in creation order (D86.9). The status is derived from the order and the
 * time, never stored; a legacy `status` field (before run 86) is ignored on read and not written.
 */
interface KeyEntry {
  kid: string;
  publicJwk: PublicJwk;
  createdAt: string;
  /** When the key signs from. Missing on a legacy entry => `createdAt`. */
  activatesAt?: string;
  /** Set when a newer key took over: the key leaves JWKS then. Missing => gone once superseded. */
  retireAt?: string;
}

interface LiveEntry {
  entry: KeyEntry;
  status: KeyStatus;
  activatesAt: number;
}

export interface LocalKeyProviderOptions {
  /** KEY_PREPUBLISH_SEC (D86.9); default 0 = the new key signs at once. */
  prepublishSec?: number;
  now?: () => number;
}

const STATE_FILE = 'keys.json';

/**
 * DEV-ONLY key provider (plan D9). RSA-2048 private keys live as PKCS8 PEM files
 * in `KEY_LOCAL_DIR` (git-ignored, mode 0600); state (kid/times/public JWK) in
 * `keys.json`. Private keys never go to MongoDB (INV-19). A key's private file is
 * deleted by the first rotation after it stopped signing — only its public JWK is
 * kept. Pre-publish (run 86, D86.9): a normal rotation's key is pending for
 * `prepublishSec`, the old key keeps signing (and its PEM) until then.
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

  readonly prepublishSec: number;
  private readonly now: () => number;

  constructor(
    private readonly dir: string,
    opts: LocalKeyProviderOptions = {},
  ) {
    this.prepublishSec = opts.prepublishSec ?? 0;
    // Read at every call (not bound at construction), so a test spying on `Date.now` is honoured.
    this.now = opts.now ?? (() => Date.now());
  }

  /** Create the directory and a first key (signs at once) if no key is live. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entries = await this.readState();
    if (LocalKeyProvider.live(entries, this.now()).length === 0) {
      const now = this.now();
      entries.push(await this.createKey(now, now));
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
      files = await this.listDir(this.dir);
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
    const active = (await this.liveEntries()).find((e) => e.status === 'active')?.entry;
    if (!active) {
      throw new Error('No active signing key');
    }
    const pem = await readFile(this.pemPath(active.kid), 'utf8');
    return { kid: active.kid, privateKey: createPrivateKey(pem) };
  }

  /** Read-only (DEBT-145): expired retiring keys are filtered here and pruned by `rotate`. */
  async getPublicKeys(): Promise<PublicJwk[]> {
    return (await this.liveEntries()).map((e) => e.entry.publicJwk);
  }

  async listKeys(): Promise<KeyMetadata[]> {
    return (await this.liveEntries()).map(({ entry, status, activatesAt }) => ({
      kid: entry.kid,
      alg: entry.publicJwk.alg,
      status,
      createdAt: entry.createdAt,
      activatesAt: new Date(activatesAt).toISOString(),
      retireAt: status === 'retiring' ? entry.retireAt! : null,
    }));
  }

  private async liveEntries(): Promise<LiveEntry[]> {
    return LocalKeyProvider.live(await this.readState(), this.now());
  }

  /**
   * Keys in JWKS at `now`, in creation order (D86.9): active = the last key whose `activatesAt` has
   * come (none yet => the first key); later keys are pending; earlier keys are retiring while
   * `retireAt` is in the future, otherwise gone. A key that activates at its creation (init,
   * emergency, `prepublishSec` 0, legacy) counts as activated whatever the clock says, like the
   * Vault floor: a clock stepping back must never revive the previous key, whose PEM may be gone.
   */
  private static live(entries: KeyEntry[], now: number): LiveEntry[] {
    const activatesAt = (e: KeyEntry) => Date.parse(e.activatesAt ?? e.createdAt);
    let active = 0;
    entries.forEach((e, i) => {
      if (activatesAt(e) <= now || activatesAt(e) === Date.parse(e.createdAt)) active = i;
    });
    const out: LiveEntry[] = [];
    entries.forEach((entry, i) => {
      const status: KeyStatus = i > active ? 'pending' : i === active ? 'active' : 'retiring';
      if (status === 'retiring' && !(Date.parse(entry.retireAt ?? '') > now)) return;
      out.push({ entry, status, activatesAt: activatesAt(entry) });
    });
    return out;
  }

  /** Serialised (DEBT-145): every rotation sees the state the previous one wrote. */
  rotate(mode: RotationMode, retainSec: number): Promise<RotationResult> {
    const run = this.chain.then(() => this.rotateExclusive(mode, retainSec));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async rotateExclusive(mode: RotationMode, retainSec: number): Promise<RotationResult> {
    const now = this.now();
    const entries = await this.readState();
    const live = LocalKeyProvider.live(entries, now);
    const old = live.find((e) => e.status === 'active')?.entry;
    // D86.9: checked inside the mutex, so two concurrent normal rotations give one 200 and one 409.
    const pending = live.find((e) => e.status === 'pending');
    if (mode === 'normal' && pending) {
      throw new RotationPendingError(
        pending.entry.kid,
        new Date(pending.activatesAt).toISOString(),
      );
    }
    const fresh = await this.createKey(
      now,
      mode === 'emergency' ? now : now + this.prepublishSec * 1000,
    );

    // DEBT-007: PERSIST the new state (atomically) BEFORE deleting any old private PEM. If the
    // write fails, `rotate` rejects but the OLD key is still active in `keys.json` AND its PEM is
    // still on disk, so `getSigningKey()` keeps working (no DoS). Deleting PEMs first would leave
    // `keys.json` pointing at a missing file on a write failure. The freshly-written PEM that never
    // made it into state is a harmless orphan (never used to sign); we do NOT garbage-collect
    // orphans here — two processes sharing the key dir (rolling deploy) would delete each other's
    // just-created PEM before the state write (re-creating the very bug this fixes).
    let next: KeyEntry[];
    if (mode === 'emergency') {
      next = [fresh]; // drop the old key, every retiring and every pending key (spec §6.4, D85.7)
    } else {
      // The old key signs until the new one activates, then stays verify-only for `retainSec`.
      const retireAt = new Date(Date.parse(fresh.activatesAt!) + retainSec * 1000).toISOString();
      // Prune expired retiring keys here, inside the mutex. Written without `status` (D86.9).
      next = [
        ...live.map(({ entry: { kid, publicJwk, createdAt, retireAt: r }, activatesAt }) => ({
          kid,
          publicJwk,
          createdAt,
          activatesAt: new Date(activatesAt).toISOString(),
          ...(kid === old?.kid ? { retireAt } : r ? { retireAt: r } : {}),
        })),
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
    } else {
      // D86.9: keep the PEM of every key that still signs or will sign (the old active key keeps
      // signing until `fresh.activatesAt`); drop the rest (retiring, pruned).
      const signing = new Set(
        LocalKeyProvider.live(next, now)
          .filter((e) => e.status !== 'retiring')
          .map((e) => e.entry.kid),
      );
      await Promise.all(
        entries.filter((e) => !signing.has(e.kid)).map((e) => this.removePem(e.kid, 'normal')),
      );
    }

    return { newKid: fresh.kid, oldKid: old?.kid ?? null, mode, activatesAt: fresh.activatesAt! };
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

  private async createKey(createdAt: number, activatesAt: number): Promise<KeyEntry> {
    const kid = randomUUID();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    await writeFile(this.pemPath(kid), pem, { mode: 0o600 });

    const { n, e } = createPublicKey(privateKey).export({ format: 'jwk' });
    return {
      kid,
      publicJwk: { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n: n as string, e: e as string },
      createdAt: new Date(createdAt).toISOString(),
      activatesAt: new Date(activatesAt).toISOString(),
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

  /** List `dir`; isolated (like `atomicRename`) so the DEBT-163 `readdir`-failure branch is testable. */
  protected listDir(dir: string): Promise<string[]> {
    return readdir(dir);
  }
}
