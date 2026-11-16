import { Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** One encryption key of `MFA_ENCRYPTION_KEYS` (D89.12). */
export interface MfaKey {
  kid: string;
  key: Buffer;
}

/** A TOTP seed at rest: AES-256-GCM, every field base64 except `kid`. */
export interface SealedSecret {
  kid: string;
  iv: string;
  ct: string;
  tag: string;
}

/** DI token of the app's `MfaKeyring`. */
export const MFA_KEYRING = 'MFA_KEYRING';

const KID = /^[a-z0-9-]{1,16}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** AAD of a stored secret: bound to its user, so a ciphertext copied to another user never opens. */
export const totpAad = (userId: string): string => `totp:v1:${userId}`;
/** AAD of a pending enrollment secret (Redis): never interchangeable with a stored one. */
export const enrollAad = (userId: string): string => `totp:enr:v1:${userId}`;

/**
 * `kid:base64,kid:base64,...`; the first entry is the current key. Errors name the variable and the
 * entry position only, never a value.
 */
export function parseMfaKeys(raw: string): MfaKey[] {
  if (raw.trim() === '') throw new Error('MFA_ENCRYPTION_KEYS must list at least one kid:key');
  const seen = new Set<string>();
  return raw.split(',').map((entry, i) => {
    const fail = (why: string) => new Error(`MFA_ENCRYPTION_KEYS entry ${i + 1}: ${why}`);
    const sep = entry.indexOf(':');
    if (sep === -1) throw fail('expected kid:base64');
    const kid = entry.slice(0, sep).trim();
    const b64 = entry.slice(sep + 1).trim();
    if (!KID.test(kid)) throw fail('kid must match [a-z0-9-]{1,16}');
    if (seen.has(kid)) throw fail('duplicated kid');
    seen.add(kid);
    const key = BASE64.test(b64) ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
    if (key.length !== 32) throw fail('key must be 32 bytes in base64');
    return { kid, key };
  });
}

/** AES-256-GCM over the env keyring; `open` never throws to a request (null + one ERROR line). */
export class MfaKeyring {
  private readonly logger = new Logger('MfaKeyring');
  private readonly keys: Map<string, Buffer>;
  readonly currentKid: string;

  constructor(keys: MfaKey[]) {
    if (keys.length === 0) throw new Error('MFA_ENCRYPTION_KEYS must list at least one kid:key');
    this.keys = new Map(keys.map((k) => [k.kid, k.key]));
    this.currentKid = keys[0].kid;
  }

  seal(plain: Buffer, aad: string): SealedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.currentKid)!, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return {
      kid: this.currentKid,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  /** The plaintext, or null (unknown kid, bad iv/tag, other AAD) logged with `kid` + `requestId`. */
  open(sealed: SealedSecret, aad: string, requestId?: string): Buffer | null {
    try {
      const key = this.keys.get(sealed.kid);
      const iv = Buffer.from(sealed.iv, 'base64');
      const tag = Buffer.from(sealed.tag, 'base64');
      if (!key || iv.length !== 12 || tag.length !== 16) throw new Error('shape');
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
    } catch {
      const kid = KID.test(String(sealed.kid)) ? sealed.kid : 'invalid';
      this.logger.error(
        `mfa secret could not be decrypted (kid=${kid}, requestId=${requestId ?? '-'})`,
      );
      return null;
    }
  }
}
