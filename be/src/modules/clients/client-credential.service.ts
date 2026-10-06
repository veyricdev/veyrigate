import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { generateToken, hashPassword, verifyPassword } from '../../common/crypto/crypto.util';
import type { ClientConfig } from '../../config/configuration';

export interface ClientCredential {
  clientId: string;
  secretHash: string;
  version: number;
  createdAt: Date;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

export interface IssuedSecret {
  /** Raw secret — returned exactly once, never persisted/logged in this form (INV-18/INV-20). */
  secret: string;
  version: number;
}

export interface VerifySecretResult {
  valid: boolean;
  version?: number;
}

// Argon2id hash of a random 32-byte value, computed once at import time, used to equalise the
// cost of verifying when a client has no valid credential (unknown client_id or fully expired/
// revoked) — mirrors the DUMMY_HASH pattern in authentication.service.ts (tech-lead C4).
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(generateToken());
  }
  return dummyHashPromise;
}

/**
 * `ClientCredential` (B3.1/B3.3, spec §9.3, INV-18). Secrets are hashed with Argon2id
 * (`hashPassword`/`verifyPassword` — tech-lead C6; the Argon2 verify itself is the
 * constant-time comparison, there is no separate `constantTimeEqual` step here).
 *
 * Rotation has overlap: `rotate()` issues a new version and only *starts* the grace countdown
 * on the previous version (sets its `expiresAt`) — it does not revoke it immediately. The grace
 * TTL is `CLIENT_SECRET_GRACE_TTL` (tech-lead C2; spec §17 not finalised).
 */
@Injectable()
export class ClientCredentialService {
  private readonly graceMs: number;

  constructor(
    @InjectModel('ClientCredential') private readonly credentials: Model<ClientCredential>,
    config: ConfigService,
  ) {
    this.graceMs = config.getOrThrow<ClientConfig>('client').secretGraceTtl * 1000;
  }

  /** Issue the first credential (version 1) for a client. */
  async createSecret(clientId: string): Promise<IssuedSecret> {
    const secret = generateToken();
    const secretHash = await hashPassword(secret);
    await this.credentials.create({ clientId, secretHash, version: 1 });
    return { secret, version: 1 };
  }

  /**
   * Rotate: issue a new credential version and start the grace countdown on the previous
   * active version (its `expiresAt` becomes `now + grace`, unless it already expires sooner).
   */
  async rotateSecret(clientId: string): Promise<IssuedSecret> {
    const now = new Date();
    const active = await this.listActive(clientId, now);
    const nextVersion = active.length ? Math.max(...active.map((c) => c.version)) + 1 : 1;

    const secret = generateToken();
    const secretHash = await hashPassword(secret);
    await this.credentials.create({ clientId, secretHash, version: nextVersion });

    const graceDeadline = new Date(now.getTime() + this.graceMs);
    await this.credentials.updateMany(
      {
        clientId,
        version: { $lt: nextVersion },
        revokedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: graceDeadline } }],
      },
      { $set: { expiresAt: graceDeadline } },
    );
    return { secret, version: nextVersion };
  }

  /** Immediately revoke a specific credential version (bypasses any remaining grace). */
  async revokeSecret(clientId: string, version: number): Promise<boolean> {
    const res = await this.credentials.updateOne(
      { clientId, version, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return res.matchedCount === 1;
  }

  /**
   * Verify a presented secret against every currently-valid credential of `clientId`
   * (overlap-aware). Always performs at least one Argon2 verify — even for an unknown
   * `clientId` or a client with zero valid credentials — to equalise timing (tech-lead C4).
   * Checks every valid version without short-circuiting on the first match.
   */
  async verifySecret(clientId: string, secret: string): Promise<VerifySecretResult> {
    const active = await this.listActive(clientId, new Date());
    if (active.length === 0) {
      await verifyPassword(await getDummyHash(), secret).catch(() => false);
      return { valid: false };
    }
    const results = await Promise.all(
      active.map(async (cred) => ({
        version: cred.version,
        ok: await verifyPassword(cred.secretHash, secret).catch(() => false),
      })),
    );
    const matched = results.find((r) => r.ok);
    return matched ? { valid: true, version: matched.version } : { valid: false };
  }

  private async listActive(clientId: string, now: Date): Promise<ClientCredential[]> {
    return this.credentials
      .find({
        clientId,
        revokedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      })
      .lean<ClientCredential[]>()
      .exec();
  }
}
