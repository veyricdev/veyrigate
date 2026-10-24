import { Logger } from '@nestjs/common';
import { calculateJwkThumbprint, type JWTPayload } from 'jose';
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { VaultConfig } from '../../config/configuration';
import { encodeCompactJws } from './jws';
import type {
  KeyMetadata,
  KeyProvider,
  PublicJwk,
  RotationMode,
  RotationResult,
} from './key-provider';

/**
 * Metadata cache TTL. Bounds both the Vault load of `/jwks.json` (≤ 1 read per 30 s) and how long
 * another instance keeps accepting a key after an emergency rotation here. Also added to the
 * retiring window: another instance may still sign with v for up to this long after v+1 exists.
 */
export const KEY_CACHE_TTL_MS = 30_000;
/** An unknown token `kid` forces at most one metadata refresh per 5 s (no amplification on Vault). */
export const KID_REFRESH_COOLDOWN_MS = 5_000;

const RSA_TYPES = new Set(['rsa-2048', 'rsa-3072', 'rsa-4096']);
const SIGNATURE_RE = /^vault:v(\d+):([A-Za-z0-9+/]+={0,2})$/;

// Shape recorded from Vault 2.1.2 (runs/53-B7.3/log.md). Required fields are type-checked; extra
// fields are allowed (Vault adds some per release, e.g. `hybrid_public_key`). Anything else ⇒ throw.
const keyInfoSchema = z.object({
  data: z.object({
    type: z.string(),
    exportable: z.boolean(),
    allow_plaintext_backup: z.boolean(),
    supports_signing: z.boolean(),
    latest_version: z.number().int().positive(),
    min_decryption_version: z.number().int().nonnegative(),
    min_encryption_version: z.number().int().nonnegative(),
    min_available_version: z.number().int().nonnegative(),
    keys: z.unknown(),
  }),
});
const versionsSchema = z.record(
  z.string().regex(/^[1-9]\d*$/),
  z.object({ creation_time: z.string(), public_key: z.string() }),
);
const signResponseSchema = z.object({ data: z.object({ signature: z.string() }) });

interface VersionEntry {
  version: number;
  kid: string;
  jwk: PublicJwk;
  publicKey: KeyObject;
  createdAt: number;
}

interface KeySet {
  latest: number;
  /** Versions below this are no longer accepted for verification (emergency / trim). */
  floor: number;
  versions: Map<number, VersionEntry>;
}

/** Vault answered with an error status (the request reached Vault). */
class VaultStatusError extends Error {
  constructor(
    op: string,
    readonly status: number,
  ) {
    super(`vault ${op} failed: status=${status}`);
  }
}

/** Never retried / logged with more than the op and status or error name (no token, body, path). */
class VaultNetworkError extends Error {
  constructor(op: string, name: string) {
    super(`vault ${op} failed: ${name}`);
  }
}

export interface VaultProviderDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * Production key provider (plan D9, run 53): HashiCorp Vault Transit. The RSA private key is
 * created by ops as `exportable=false` and never leaves Vault (INV-19); this class only asks Vault
 * to sign. All key state (versions, retiring window, emergency floor) is derived from Vault metadata
 * — no local state, so several instances and rotations need no mutex here (Vault serialises).
 */
export class VaultTransitKeyProvider implements KeyProvider {
  private readonly logger = new Logger(VaultTransitKeyProvider.name);
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly base: string;
  // ES private fields (not properties): never enumerated by inspect/test printers, so the token and
  // the token file path cannot leak through a dumped provider object.
  #token = '';
  readonly #cfg: VaultConfig;
  private cache?: { set: KeySet; expiresAt: number };
  private inflight?: Promise<KeySet>;
  /** Monotonic load counter: an older load finishing late must not overwrite a newer key set. */
  private seq = 0;
  private cachedSeq = 0;
  private lastHintRefresh = Number.NEGATIVE_INFINITY;

  constructor(
    cfg: VaultConfig,
    /** ACCESS_TOKEN_TTL (s): how long a retired version must stay in JWKS. */
    private readonly accessTokenTtlSec: number,
    deps: VaultProviderDeps = {},
  ) {
    this.#cfg = cfg;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? Date.now;
    this.base = `${cfg.addr.replace(/\/+$/, '')}/v1/${cfg.mount}/`;
  }

  /** Boot check (fail-closed): token readable, key exists, is RSA, non-exportable and can sign. */
  async init(): Promise<void> {
    await this.loadToken();
    await this.refresh(true);
  }

  async signJwt(header: { typ: string }, payload: JWTPayload): Promise<string> {
    const set = await this.keySet();
    try {
      return await this.signWith(set, header, payload);
    } catch (err) {
      // Vault refuses `key_version < min_encryption_version` (another instance did an emergency
      // rotation; Vault 2.1.2 answers 500, docs suggest 400). Refresh once and re-sign only when the
      // latest version really changed — otherwise the original error stands. Shared (single-flight)
      // refresh (DEBT-395): N concurrent refused signs cost one metadata read, not N, on a weak Vault.
      if (!(err instanceof VaultStatusError) || !(err.status === 400 || err.status >= 500)) {
        throw err;
      }
      const fresh = await this.refresh(false);
      if (fresh.latest === set.latest) throw err;
      return this.signWith(fresh, header, payload);
    }
  }

  async getPublicKeys(kidHint?: string): Promise<PublicJwk[]> {
    let set = await this.keySet();
    if (
      kidHint !== undefined &&
      ![...set.versions.values()].some((v) => v.kid === kidHint) &&
      this.now() - this.lastHintRefresh >= KID_REFRESH_COOLDOWN_MS
    ) {
      this.lastHintRefresh = this.now();
      set = await this.refresh(false);
    }
    return this.live(set).map(({ entry }) => entry.jwk);
  }

  async listKeys(): Promise<KeyMetadata[]> {
    return this.live(await this.keySet()).map(({ entry, retireAt }) => ({
      kid: entry.kid,
      alg: 'RS256' as const,
      status: retireAt === null ? ('active' as const) : ('retiring' as const),
      createdAt: new Date(entry.createdAt).toISOString(),
      retireAt: retireAt === null ? null : new Date(retireAt).toISOString(),
    }));
  }

  /**
   * `retainSec` is not stored: the retiring window is derived from Vault metadata with the same
   * ACCESS_TOKEN_TTL this provider was built with (KeyRotationService passes that value too).
   */
  async rotate(mode: RotationMode, _retainSec: number): Promise<RotationResult> {
    const before = await this.refresh(true);
    const oldKid = before.versions.get(before.latest)!.kid;
    await this.call('rotate', 'POST', `keys/${this.#cfg.key}/rotate`, undefined, false);
    this.invalidate();
    const after = await this.refresh(true);
    const n = after.latest;
    const newKid = after.versions.get(n)!.kid;
    if (mode === 'emergency') {
      // Vault then refuses to sign with any older version (every instance) and this instance stops
      // accepting them at once; others within KEY_CACHE_TTL_MS. A failure here propagates (5xx +
      // audited failure); re-running the emergency rotation converges.
      await this.call(
        'config',
        'POST',
        `keys/${this.#cfg.key}/config`,
        { min_decryption_version: n, min_encryption_version: n },
        false,
      );
      this.invalidate();
      try {
        // Destroys the old key material (irreversible) — intended for a compromised key.
        await this.call(
          'trim',
          'POST',
          `keys/${this.#cfg.key}/trim`,
          { min_available_version: n },
          false,
        );
      } catch {
        this.logger.error(`trim failed after emergency rotation (new kid ${newKid})`);
      }
    }
    return { newKid, oldKid, mode };
  }

  private async signWith(
    set: KeySet,
    header: { typ: string },
    payload: JWTPayload,
  ): Promise<string> {
    const entry = set.versions.get(set.latest)!;
    return encodeCompactJws(
      { alg: 'RS256', kid: entry.kid, typ: header.typ },
      payload,
      async (input) => {
        const res = await this.call(
          'sign',
          'POST',
          `sign/${this.#cfg.key}`,
          {
            input: input.toString('base64'),
            key_version: entry.version,
            hash_algorithm: 'sha2-256',
            signature_algorithm: 'pkcs1v15', // RS256; Vault's default for RSA is PSS
          },
          true,
        );
        const parsed = signResponseSchema.safeParse(res);
        const m = parsed.success ? SIGNATURE_RE.exec(parsed.data.data.signature) : null;
        if (!m || Number(m[1]) !== entry.version) {
          throw new Error('vault sign failed: unexpected signature format or key version');
        }
        const signature = Buffer.from(m[2], 'base64');
        // Fail closed: never hand out a token whose signature does not verify under the kid we put in
        // its header (wrong padding, wrong version, corrupted response).
        if (!verify('sha256', input, entry.publicKey, signature)) {
          throw new Error('vault sign failed: signature does not verify');
        }
        return signature;
      },
    );
  }

  /** Versions in JWKS: the latest (active) + older ones ≥ floor whose retiring window is open. */
  private live(set: KeySet): Array<{ entry: VersionEntry; retireAt: number | null }> {
    const now = this.now();
    const out: Array<{ entry: VersionEntry; retireAt: number | null }> = [];
    for (const entry of [...set.versions.values()].sort((a, b) => a.version - b.version)) {
      if (entry.version === set.latest) {
        out.push({ entry, retireAt: null });
        continue;
      }
      const next = set.versions.get(entry.version + 1);
      if (entry.version < set.floor || !next) continue;
      const retireAt = next.createdAt + this.accessTokenTtlSec * 1000 + KEY_CACHE_TTL_MS;
      if (retireAt > now) out.push({ entry, retireAt });
    }
    return out;
  }

  private keySet(): Promise<KeySet> {
    if (this.cache && this.now() < this.cache.expiresAt) return Promise.resolve(this.cache.set);
    return this.refresh(false);
  }

  /** Single-flight load; `force` starts a new load even if one is in flight (after a mutation). */
  private refresh(force: boolean): Promise<KeySet> {
    if (this.inflight && !force) return this.inflight;
    const mine = ++this.seq;
    const p = this.load().then((set) => {
      if (mine > this.cachedSeq) {
        this.cachedSeq = mine;
        this.cache = { set, expiresAt: this.now() + KEY_CACHE_TTL_MS };
      }
      return set;
    });
    this.inflight = p;
    p.finally(() => {
      if (this.inflight === p) this.inflight = undefined;
    }).catch(() => undefined);
    return p;
  }

  private invalidate(): void {
    this.cache = undefined;
    this.inflight = undefined;
    this.cachedSeq = ++this.seq;
  }

  private async load(): Promise<KeySet> {
    const res = await this.call('read', 'GET', `keys/${this.#cfg.key}`, undefined, true);
    const info = keyInfoSchema.safeParse(res);
    if (!info.success) throw new Error('vault read failed: unexpected key metadata shape');
    const d = info.data.data;
    if (!RSA_TYPES.has(d.type) || d.supports_signing !== true) {
      throw new Error('vault key must be an RSA signing key (rsa-2048/3072/4096)');
    }
    if (d.exportable || d.allow_plaintext_backup) {
      throw new Error('vault key must not be exportable nor allow plaintext backup');
    }
    const raw = versionsSchema.safeParse(d.keys);
    if (!raw.success) throw new Error('vault read failed: unexpected key versions shape');
    const versions = new Map<number, VersionEntry>();
    for (const [v, { creation_time, public_key }] of Object.entries(raw.data)) {
      const createdAt = Date.parse(creation_time);
      if (!Number.isFinite(createdAt)) throw new Error('vault read failed: bad creation_time');
      versions.set(Number(v), { version: Number(v), createdAt, ...(await toJwk(public_key)) });
    }
    if (!versions.has(d.latest_version)) {
      throw new Error('vault read failed: latest version has no public key');
    }
    return {
      latest: d.latest_version,
      floor: Math.max(d.min_decryption_version, d.min_available_version),
      versions,
    };
  }

  /** Read the Vault Agent token sink. Errors never carry the path or the content. */
  private async loadToken(): Promise<void> {
    let token: string;
    try {
      token = (await readFile(this.#cfg.tokenFile, 'utf8')).trim();
    } catch (err) {
      throw new Error(
        `Vault token file could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
      );
    }
    // Printable ASCII only: an empty token or a CR/LF would otherwise reach the HTTP header (and the
    // fetch error message would echo it).
    if (!/^[\x21-\x7e]+$/.test(token)) {
      throw new Error('Vault token file is empty or has invalid content');
    }
    this.#token = token;
  }

  /**
   * One Vault request. `retryable` (sign/read only): one retry on network error/timeout/5xx, and a
   * 403 re-reads the token file once (Vault Agent may have renewed it). rotate/config/trim never
   * retry: a lost response could mean the mutation already happened.
   */
  private async call(
    op: string,
    method: 'GET' | 'POST',
    path: string,
    body: object | undefined,
    retryable: boolean,
  ): Promise<unknown> {
    let retried = false;
    let reloaded = false;
    for (;;) {
      try {
        return await this.attempt(op, method, path, body);
      } catch (err) {
        if (retryable && err instanceof VaultStatusError && err.status === 403 && !reloaded) {
          reloaded = true;
          await this.loadToken();
          continue;
        }
        const transient =
          err instanceof VaultNetworkError ||
          (err instanceof VaultStatusError && err.status >= 500);
        if (retryable && transient && !retried) {
          retried = true;
          continue;
        }
        this.logger.error((err as Error).message);
        throw err;
      }
    }
  }

  private async attempt(
    op: string,
    method: 'GET' | 'POST',
    path: string,
    body: object | undefined,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, {
        method,
        headers: {
          'X-Vault-Token': this.#token,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.#cfg.timeoutMs),
      });
    } catch (err) {
      throw new VaultNetworkError(op, (err as Error).name || 'Error');
    }
    try {
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined); // drain; the body is never logged
        throw new VaultStatusError(op, res.status);
      }
      return res.status === 204 ? null : await res.json();
    } catch (err) {
      if (err instanceof VaultStatusError) throw err;
      throw new VaultNetworkError(op, (err as Error).name || 'Error');
    }
  }
}

/** RSA public key (PEM) ⇒ JWKS entry with kid = RFC 7638 thumbprint. RSA ≥ 2048 bits only. */
async function toJwk(pem: string): Promise<Pick<VersionEntry, 'kid' | 'jwk' | 'publicKey'>> {
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(pem);
  } catch {
    throw new Error('vault read failed: public_key is not a valid public key');
  }
  if (publicKey.asymmetricKeyType !== 'rsa') {
    throw new Error('vault public_key must be RSA');
  }
  if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error('vault public_key must be RSA >= 2048 bits');
  }
  const { kty, n, e } = publicKey.export({ format: 'jwk' });
  if (kty !== 'RSA' || typeof n !== 'string' || typeof e !== 'string') {
    throw new Error('vault public_key must be RSA');
  }
  const kid = await calculateJwkThumbprint({ kty, n, e }, 'sha256');
  return { kid, publicKey, jwk: { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n, e } };
}
