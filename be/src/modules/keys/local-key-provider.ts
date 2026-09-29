import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import type { KeyProvider, PublicJwk, RotationMode, RotationResult } from './key-provider';

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
 */
export class LocalKeyProvider implements KeyProvider {
  constructor(private readonly dir: string) {}

  /** Create the directory and a first active key if none exists. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entries = await this.readState();
    if (!entries.some((e) => e.status === 'active')) {
      entries.push(await this.createKey());
      await this.writeState(entries);
    }
  }

  async getSigningKey(): Promise<{ kid: string; privateKey: KeyObject }> {
    const active = (await this.readState()).find((e) => e.status === 'active');
    if (!active) {
      throw new Error('No active signing key');
    }
    const pem = await readFile(this.pemPath(active.kid), 'utf8');
    return { kid: active.kid, privateKey: createPrivateKey(pem) };
  }

  async getPublicKeys(): Promise<PublicJwk[]> {
    const now = Date.now();
    const entries = await this.readState();
    const live = entries.filter((e) => e.status === 'active' || Date.parse(e.retireAt ?? '') > now);
    if (live.length !== entries.length) {
      await this.writeState(live); // prune expired retiring keys
    }
    return live.map((e) => e.publicJwk);
  }

  async rotate(mode: RotationMode, retainSec: number): Promise<RotationResult> {
    const entries = await this.readState();
    const old = entries.find((e) => e.status === 'active');
    const fresh = await this.createKey();

    let next: KeyEntry[];
    if (mode === 'emergency') {
      // Drop the old key and every retiring key right away (spec §6.4).
      next = [fresh];
      await Promise.all(entries.map((e) => rm(this.pemPath(e.kid), { force: true })));
    } else {
      const retireAt = new Date(Date.now() + retainSec * 1000).toISOString();
      next = [
        ...entries.map((e) => (e === old ? { ...e, status: 'retiring' as const, retireAt } : e)),
        fresh,
      ];
      if (old) {
        await rm(this.pemPath(old.kid), { force: true }); // verify-only from now on
      }
    }
    await this.writeState(next);
    return { newKid: fresh.kid, oldKid: old?.kid ?? null, mode };
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
    await writeFile(join(this.dir, STATE_FILE), JSON.stringify(entries, null, 2), { mode: 0o600 });
  }
}
