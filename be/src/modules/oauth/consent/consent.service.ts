import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import type { ConsentConfig } from '../../../config/configuration';

/**
 * A stored consent record (spec Â§9.4, Â§10). Key = `userId Ã— clientId Ã— resource` (Q1, plan Â§12).
 * `resource` uses the sentinel `''` for requests that carry no RFC 8707 `resource`.
 */
export interface Consent {
  userId: Types.ObjectId;
  clientId: string;
  resource: string;
  grantedScopes: string[];
  policyVersion?: string;
  termsVersion?: string;
  grantedAt: Date;
  updatedAt: Date;
  revokedAt?: Date | null;
}

/** Current policy/terms versions a grant must match to still "cover" a request. */
export interface ConsentVersions {
  policyVersion: string;
  termsVersion: string;
}

/**
 * Consent store/service (B4.2a, spec Â§9.4/Â§10).
 *
 * Granularity `user Ã— client Ã— resource` (Q1). The owner is always the `userId` taken from the
 * authenticated session by the caller â€” this service never derives identity from client input.
 * A request without `resource` is normalised to the sentinel `''` before it reaches here (see
 * `normalizeResource`), so there is exactly one composite unique key and no null-collision.
 *
 * `isCovered` is the gate for skipping the consent screen: it returns true ONLY when the active
 * grant covers every requested scope AND matches the current policy/terms versions â€” any mismatch
 * (missing scope, bumped version, revoked grant) forces re-consent (fail-closed, never
 * auto-approve).
 */
@Injectable()
export class ConsentService {
  constructor(
    @InjectModel('Consent') private readonly consents: Model<Consent>,
    private readonly config: ConfigService,
  ) {}

  /** Normalise an optional `resource` to the storage/lookup sentinel (`undefined` -> `''`). */
  static normalizeResource(resource: string | undefined): string {
    return resource ?? '';
  }

  /** Current policy/terms versions from config (env). Never hardcoded at call sites. */
  currentVersions(): ConsentVersions {
    const { policyVersion, termsVersion } = this.config.getOrThrow<ConsentConfig>('consent');
    return { policyVersion, termsVersion };
  }

  /** Find the active (non-revoked) consent for an owner + client + resource, if any. */
  async find(
    userId: string,
    clientId: string,
    resource: string | undefined,
  ): Promise<Consent | null> {
    return this.consents
      .findOne({
        userId: new Types.ObjectId(userId),
        clientId,
        resource: ConsentService.normalizeResource(resource),
        revokedAt: null,
      })
      .lean<Consent>()
      .exec();
  }

  /**
   * True only when `consent` covers every requested scope AND matches the current versions.
   * A null consent, a missing scope, or any version drift returns false (fail-closed).
   */
  isCovered(
    consent: Consent | null,
    requestedScopes: string[],
    versions: ConsentVersions,
  ): boolean {
    if (!consent || consent.revokedAt) return false;
    if (consent.policyVersion !== versions.policyVersion) return false;
    if (consent.termsVersion !== versions.termsVersion) return false;
    const granted = new Set(consent.grantedScopes);
    return requestedScopes.every((s) => granted.has(s));
  }

  /**
   * Record consent for an owner + client + resource. Atomic upsert on the unique composite key:
   * two concurrent grants for the same key can never produce a duplicate (the unique index plus
   * `upsert` collapse them into one document). `grantedScopes` is the union of the already-granted
   * scopes and the newly requested ones, bounded by `allowedScopes` (the client's *current* scopes)
   * so a scope the client has since lost can never be carried forward. Clears `revokedAt`.
   */
  async grant(
    userId: string,
    clientId: string,
    resource: string | undefined,
    requestedScopes: string[],
    versions: ConsentVersions,
    allowedScopes: string[],
  ): Promise<Consent> {
    const normResource = ConsentService.normalizeResource(resource);
    const allowed = new Set(allowedScopes);
    const existing = await this.consents
      .findOne({
        userId: new Types.ObjectId(userId),
        clientId,
        resource: normResource,
      })
      .lean<Consent>()
      .exec();
    const union = new Set<string>();
    for (const s of existing?.grantedScopes ?? []) if (allowed.has(s)) union.add(s);
    for (const s of requestedScopes) if (allowed.has(s)) union.add(s);
    const now = new Date();
    const doc = await this.consents
      .findOneAndUpdate(
        { userId: new Types.ObjectId(userId), clientId, resource: normResource },
        {
          $set: {
            grantedScopes: [...union],
            policyVersion: versions.policyVersion,
            termsVersion: versions.termsVersion,
            updatedAt: now,
            revokedAt: null,
          },
          $setOnInsert: { grantedAt: now },
        },
        { upsert: true, returnDocument: 'after' },
      )
      .lean<Consent>()
      .exec();
    return doc as Consent;
  }
}
