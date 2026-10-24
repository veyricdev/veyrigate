import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import type { VaultConfig } from '../../config/configuration';
import { KEY_CACHE_TTL_MS, VaultTransitKeyProvider } from './vault-transit-key-provider';

/**
 * Unit tests (run 53, V7–V12) against an in-memory fake of the Vault Transit HTTP API. The fake
 * mirrors the response shape recorded from Vault 2.1.2 (runs/53-B7.3/log.md). The same behaviours
 * run against a real Vault in `test/vault-transit.vault-spec.ts`.
 */

const TOKEN = 'hvs.unit-canary-token-0123456789';
const TTL = 900;

type Version = { priv: KeyObject; pem: string; created: string };

class FakeVault {
  versions = new Map<number, Version>();
  latest = 0;
  minDec = 1;
  minEnc = 0;
  minAvail = 0;
  info: Record<string, unknown> = {
    type: 'rsa-2048',
    exportable: false,
    allow_plaintext_backup: false,
    supports_signing: true,
  };
  calls: string[] = [];
  /** Per-op overrides: return this Response (or throw) instead of the normal behaviour. */
  fail: Record<string, Array<() => Response>> = {};
  tamper?: (sig: string) => string;
  validToken = TOKEN;

  constructor(bits = 2048) {
    this.rotate(bits);
  }

  rotate(bits = 2048): void {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
    this.latest += 1;
    this.versions.set(this.latest, {
      priv: privateKey,
      pem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
      created: new Date().toISOString(),
    });
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v1\/transit\//, '');
    const op =
      init?.method === 'GET'
        ? 'read'
        : path.startsWith('sign/')
          ? 'sign'
          : (path.split('/').pop() as string);
    this.calls.push(op);
    const queued = this.fail[op]?.shift();
    if (queued) return queued();
    if ((init?.headers as Record<string, string>)['X-Vault-Token'] !== this.validToken) {
      return json(403, { errors: ['permission denied'] });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (op === 'read') return json(200, { data: this.data() });
    if (op === 'sign') {
      const v = body.key_version as number;
      const ver = this.versions.get(v);
      if (!ver || v < this.minEnc || v > this.latest) return json(500, { errors: ['bad version'] });
      if (body.hash_algorithm !== 'sha2-256' || body.signature_algorithm !== 'pkcs1v15') {
        return json(400, { errors: ['unexpected algorithm'] });
      }
      const sig = cryptoSign('sha256', Buffer.from(body.input, 'base64'), ver.priv).toString(
        'base64',
      );
      const out = `vault:v${v}:${sig}`;
      return json(200, {
        data: { key_version: v, signature: this.tamper ? this.tamper(out) : out },
      });
    }
    if (op === 'rotate') {
      this.rotate();
      return json(200, { data: this.data() });
    }
    if (op === 'config') {
      this.minDec = body.min_decryption_version;
      this.minEnc = body.min_encryption_version;
      return json(200, { data: this.data() });
    }
    if (op === 'trim') {
      this.minAvail = body.min_available_version;
      for (const v of [...this.versions.keys()]) if (v < this.minAvail) this.versions.delete(v);
      return json(200, { data: this.data() });
    }
    return json(404, { errors: [] });
  };

  data(): Record<string, unknown> {
    const keys: Record<string, unknown> = {};
    for (const [v, ver] of this.versions) {
      keys[String(v)] = {
        certificate_chain: '',
        creation_time: ver.created,
        hybrid_public_key: '',
        name: 'rsa-2048',
        public_key: ver.pem,
      };
    }
    return {
      ...this.info,
      deletion_allowed: false,
      derived: false,
      latest_version: this.latest,
      min_available_version: this.minAvail,
      min_decryption_version: this.minDec,
      min_encryption_version: this.minEnc,
      name: 'k',
      keys,
    };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('VaultTransitKeyProvider (run 53, unit V7–V12)', () => {
  let dir: string;
  let tokenFile: string;
  let vault: FakeVault;
  let clock: number;
  let logs: string[];

  const cfg = (over: Partial<VaultConfig> = {}): VaultConfig => ({
    addr: 'http://vault.unit.test:8200',
    tokenFile,
    mount: 'transit',
    key: 'k',
    timeoutMs: 2000,
    ...over,
  });
  const make = (over: Partial<VaultConfig> = {}, fetchFn = vault.fetch, ttl = TTL) =>
    new VaultTransitKeyProvider(cfg(over), ttl, { fetchFn, now: () => clock });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vg-vault-unit-'));
    tokenFile = join(dir, 'token');
    await writeFile(tokenFile, `${TOKEN}\n`);
    vault = new FakeVault();
    clock = Date.now();
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((msg: unknown) => void logs.push(String(msg)));
    }
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
    // Exposure invariant for every test: no token, token file path or PEM ever reaches a log line.
    for (const line of logs) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(dir);
      expect(line).not.toContain('BEGIN PUBLIC KEY');
    }
  });

  it('signs RS256 PKCS#1 v1.5 via Transit; kid = RFC 7638 thumbprint; token verifies with its JWKS', async () => {
    const p = make();
    await p.init();
    const token = await p.signJwt({ typ: 'JWT' }, { sub: 'u', iss: 'i' });
    const header = decodeProtectedHeader(token);
    expect(Object.keys(header)).toEqual(['alg', 'kid', 'typ']);
    const keys = await p.getPublicKeys();
    expect(keys).toHaveLength(1);
    expect(header.kid).toBe(keys[0].kid);
    expect(keys[0].kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
    await expect(jwtVerify(token, createLocalJWKSet({ keys }))).resolves.toBeDefined();
  });

  describe('V7: init refuses an unsafe or unusable key', () => {
    it.each([
      ['exportable', { exportable: true }],
      ['allow_plaintext_backup', { allow_plaintext_backup: true }],
      ['non-RSA type', { type: 'aes256-gcm96' }],
      ['ecdsa type', { type: 'ecdsa-p256' }],
      ['cannot sign', { supports_signing: false }],
    ])('%s', async (_name, info) => {
      Object.assign(vault.info, info);
      await expect(make().init()).rejects.toThrow();
    });
  });

  describe('V8: init fails closed without leaking token or path', () => {
    it('token file missing', async () => {
      await expect(make({ tokenFile: join(dir, 'missing') }).init()).rejects.toThrow(/token file/i);
    });

    it('token file empty / with control characters', async () => {
      await writeFile(tokenFile, '  \n');
      await expect(make().init()).rejects.toThrow(/token file/i);
      await writeFile(tokenFile, 'a\r\nInjected: 1');
      await expect(make().init()).rejects.toThrow(/token file/i);
    });

    it('key not found (404) / wrong token (403)', async () => {
      vault.fail.read = [() => json(404, { errors: [] })];
      await expect(make().init()).rejects.toThrow('vault read failed: status=404');
      vault.validToken = 'other';
      await expect(make().init()).rejects.toThrow('vault read failed: status=403');
    });

    it('a dumped provider object (inspect / test printer) shows neither token nor token file path', async () => {
      const p = make();
      await p.init();
      const dumps = [inspect(p, { depth: 10, showHidden: true }), JSON.stringify(p)];
      for (const d of dumps) {
        expect(d).not.toContain(TOKEN);
        expect(d).not.toContain(dir);
      }
    });

    it('error messages carry no token / path', async () => {
      vault.validToken = 'other';
      const err = (await make()
        .init()
        .catch((e: Error) => e)) as Error;
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).not.toContain(dir);
    });
  });

  describe('V9: 403 ⇒ re-read the token file once', () => {
    it('rotated token on disk ⇒ success after exactly one re-read', async () => {
      const p = make();
      await p.init();
      vault.validToken = 'hvs.rotated-token';
      await writeFile(tokenFile, 'hvs.rotated-token');
      vault.calls = [];
      await p.signJwt({ typ: 'JWT' }, {});
      expect(vault.calls).toEqual(['sign', 'sign']);
    });

    it('file still wrong ⇒ throws after exactly 2 calls', async () => {
      const p = make();
      await p.init();
      vault.validToken = 'hvs.rotated-token';
      vault.calls = [];
      await expect(p.signJwt({ typ: 'JWT' }, {})).rejects.toThrow('vault sign failed: status=403');
      expect(vault.calls).toEqual(['sign', 'sign']);
    });
  });

  describe('retry policy', () => {
    it('sign/read: one retry on 5xx or network error', async () => {
      const p = make();
      vault.fail.read = [() => json(503, {})];
      await p.init();
      vault.fail.sign = [
        () => {
          throw new TypeError('fetch failed');
        },
      ];
      vault.calls = [];
      await p.signJwt({ typ: 'JWT' }, {});
      expect(vault.calls).toEqual(['sign', 'sign']);
    });

    it('a 4xx other than 403 is not retried', async () => {
      vault.fail.read = [() => json(400, {})];
      await expect(make().init()).rejects.toThrow('status=400');
      expect(vault.calls).toEqual(['read']);
    });

    it('rotate/config/trim are never retried', async () => {
      const p = make();
      await p.init();
      vault.fail.rotate = [() => json(503, {})];
      vault.calls = [];
      await expect(p.rotate('normal', TTL)).rejects.toThrow('vault rotate failed: status=503');
      expect(vault.calls.filter((c) => c === 'rotate')).toHaveLength(1);
      vault.fail.config = [() => json(503, {})];
      vault.calls = [];
      await expect(p.rotate('emergency', TTL)).rejects.toThrow('vault config failed: status=503');
      expect(vault.calls.filter((c) => c === 'config')).toHaveLength(1);
    });

    it('trim failure after emergency: ERROR log with the new kid, rotation still succeeds', async () => {
      const p = make();
      await p.init();
      vault.fail.trim = [() => json(500, {})];
      const r = await p.rotate('emergency', TTL);
      expect(logs).toContain(`trim failed after emergency rotation (new kid ${r.newKid})`);
      expect((await p.getPublicKeys()).map((k) => k.kid)).toEqual([r.newKid]);
    });
  });

  describe('V11: Transit responses that must never become a token', () => {
    it('signature for another version (vault:v(N+1):…) ⇒ throw', async () => {
      const p = make();
      await p.init();
      vault.tamper = (s) => s.replace(/^vault:v(\d+):/, (_m, v) => `vault:v${Number(v) + 1}:`);
      await expect(p.signJwt({ typ: 'JWT' }, {})).rejects.toThrow();
    });

    it('signature with one byte flipped ⇒ throw (self-verify)', async () => {
      const p = make();
      await p.init();
      vault.tamper = (s) => {
        const [, ver, b64] = /^vault:v(\d+):(.*)$/.exec(s)!;
        const buf = Buffer.from(b64, 'base64');
        buf[10] ^= 0x01;
        return `vault:v${ver}:${buf.toString('base64')}`;
      };
      await expect(p.signJwt({ typ: 'JWT' }, {})).rejects.toThrow(/does not verify/);
    });

    it('signature not in vault:vN:<base64> form ⇒ throw', async () => {
      const p = make();
      await p.init();
      vault.tamper = (s) => s.replace('vault:', '');
      await expect(p.signJwt({ typ: 'JWT' }, {})).rejects.toThrow();
    });

    it.each([
      ['latest_version missing', (d: Record<string, unknown>) => delete d.latest_version],
      ['keys[v] is a number (AES shape)', (d: Record<string, unknown>) => (d.keys = { 1: 1 })],
      ['latest version absent from keys', (d: Record<string, unknown>) => (d.latest_version = 9)],
      [
        'bad creation_time',
        (d: Record<string, unknown>) => {
          (d.keys as Record<string, { creation_time: string }>)['1'].creation_time = 'yesterday';
        },
      ],
      ['non-numeric version id', (d: Record<string, unknown>) => (d.keys = { x: {} })],
      [
        'data missing',
        (d: Record<string, unknown>) => {
          for (const k of Object.keys(d)) delete d[k];
        },
      ],
    ])('unexpected metadata shape (%s) ⇒ init throws', async (_name, mutate) => {
      const data = vault.data();
      mutate(data);
      vault.fail.read = [() => json(200, { data })];
      await expect(make().init()).rejects.toThrow();
    });

    it('public_key not RSA ⇒ throw', async () => {
      const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
        type: 'spki',
        format: 'pem',
      }) as string;
      vault.versions.get(1)!.pem = ec;
      await expect(make().init()).rejects.toThrow(/RSA/);
    });

    it('public_key RSA < 2048 bits ⇒ throw', async () => {
      const small = new FakeVault(1024);
      await expect(make({}, small.fetch).init()).rejects.toThrow(/2048/);
    });
  });

  describe('V12: metadata cache', () => {
    it('100 getPublicKeys() within the TTL ⇒ one Vault read', async () => {
      const p = make();
      await p.init();
      for (let i = 0; i < 100; i++) {
        clock += 250; // 25 s in total, still inside the 30 s TTL
        await p.getPublicKeys();
      }
      expect(vault.calls).toEqual(['read']);
    });

    it('10 concurrent calls on an empty/expired cache ⇒ one read (single-flight)', async () => {
      const p = make();
      await p.init();
      clock += KEY_CACHE_TTL_MS + 1;
      vault.calls = [];
      await Promise.all(Array.from({ length: 10 }, () => p.getPublicKeys()));
      expect(vault.calls).toEqual(['read']);
    });

    it('expired cache + failing refresh ⇒ throw (never the stale key set)', async () => {
      const p = make();
      await p.init();
      clock += KEY_CACHE_TTL_MS + 1;
      vault.fail.read = [() => json(503, {}), () => json(503, {})];
      await expect(p.getPublicKeys()).rejects.toThrow('vault read failed: status=503');
      await expect(p.listKeys()).resolves.toHaveLength(1); // Vault back ⇒ recovers
    });

    it('unknown kid hint ⇒ at most one refresh per 5 s cooldown', async () => {
      const p = make();
      await p.init();
      for (let i = 0; i < 50; i++) await p.getPublicKeys(`random-${i}`);
      expect(vault.calls).toEqual(['read', 'read']);
      clock += 5_000;
      await p.getPublicKeys('another');
      expect(vault.calls).toEqual(['read', 'read', 'read']);
      // A known kid never refreshes.
      const [{ kid }] = await p.getPublicKeys();
      await p.getPublicKeys(kid);
      expect(vault.calls).toHaveLength(3);
    });
  });

  it('JWKS/listKeys: retiring window = createdAt(v+1) + ACCESS_TOKEN_TTL + cache TTL; emergency drops at once', async () => {
    const p = make();
    await p.init();
    const r = await p.rotate('normal', TTL);
    const created = Date.parse(vault.versions.get(2)!.created);
    const list = await p.listKeys();
    expect(list).toEqual([
      expect.objectContaining({ kid: r.oldKid, status: 'retiring' }),
      expect.objectContaining({ kid: r.newKid, status: 'active', retireAt: null }),
    ]);
    expect(Date.parse(list[0].retireAt!)).toBe(created + TTL * 1000 + KEY_CACHE_TTL_MS);
    clock = created + TTL * 1000 + KEY_CACHE_TTL_MS + 1;
    expect((await p.getPublicKeys()).map((k) => k.kid)).toEqual([r.newKid]);

    const e = await p.rotate('emergency', TTL);
    expect(e.oldKid).toBe(r.newKid);
    expect((await p.getPublicKeys()).map((k) => k.kid)).toEqual([e.newKid]);
    expect([vault.minDec, vault.minEnc, vault.minAvail]).toEqual([3, 3, 3]);
  });

  it('stale cache after another instance’s emergency rotation ⇒ refresh and re-sign once with the new kid', async () => {
    const a = make();
    const b = make();
    await a.init();
    await b.init();
    const { newKid } = await a.rotate('emergency', TTL);
    const token = await b.signJwt({ typ: 'JWT' }, {});
    expect(decodeProtectedHeader(token).kid).toBe(newKid);
  });

  describe('V10: black-hole Vault (TCP accepted, never answered)', () => {
    let server: Server;
    let port: number;
    const sockets: Socket[] = [];

    beforeAll(async () => {
      server = createServer((s) => void sockets.push(s));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as { port: number }).port;
    });

    afterAll(async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    });

    it('signJwt rejects within 2 × VAULT_TIMEOUT_MS + 500 ms (one retry), no hang', async () => {
      const timeoutMs = 300;
      // Metadata comes from the fake; only `sign` goes (with the real fetch) to the black hole.
      const hole = make({ timeoutMs }, (url, init) =>
        String(url).includes('/sign/')
          ? fetch(`http://127.0.0.1:${port}/v1/transit/sign/k`, init)
          : vault.fetch(url, init),
      );
      await hole.init();
      const started = Date.now();
      await expect(hole.signJwt({ typ: 'JWT' }, {})).rejects.toThrow(/vault sign failed/);
      expect(Date.now() - started).toBeLessThanOrEqual(2 * timeoutMs + 500);
    });
  });
});
