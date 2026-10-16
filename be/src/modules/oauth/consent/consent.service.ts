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

  /** Distinct `clientId`s the user has consent records for (admin: resolve the tenant's clients). */
  async distinctClientIds(userId: string): Promise<string[]> {
    return (await this.consents
      .distinct('clientId', { userId: new Types.ObjectId(userId) })
      .exec()) as string[];
  }

  /**
   * Admin list (B6.3b): ACTIVE consents of `userId` for `clientIds` (only clients of the token's
   * tenant), ordered by `_id`, strictly after the cursor (an `_id` hex validated by the caller).
   */
  async listActive(
    userId: string,
    clientIds: string[],
    after: string | undefined,
    limit: number,
  ): Promise<(Consent & { _id: Types.ObjectId })[]> {
    if (clientIds.length === 0) return [];
    return this.consents
      .find({
        userId: new Types.ObjectId(userId),
        clientId: { $in: clientIds },
        revokedAt: null,
        ...(after !== undefined ? { _id: { $gt: new Types.ObjectId(after) } } : {}),
      })
      .sort({ _id: 1 })
      .limit(limit)
      .lean<(Consent & { _id: Types.ObjectId })[]>()
      .exec();
  }

  /**
   * Admin revoke (B6.3b): atomically stamp `revokedAt` on the ACTIVE consent `id` of `userId` for
   * one of `clientIds`, returning it, or null when nothing matched (unknown, other user/tenant,
   * already revoked). `isCovered` then refuses it, so the next `/authorize` asks again.
   */
  async revokeById(
    id: string,
    userId: string,
    clientIds: string[],
    now: Date,
  ): Promise<Consent | null> {
    if (clientIds.length === 0) return null;
    return this.consents
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(id),
          userId: new Types.ObjectId(userId),
          clientId: { $in: clientIds },
          revokedAt: null,
        },
        { $set: { revokedAt: now } },
        { returnDocument: 'after' },
      )
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
   * Record consent for an owner + client + resource. ONE atomic update-pipeline round-trip on the
   * unique composite key (DEBT-027): two concurrent grants for the same key can never produce a
   * duplicate (the unique index plus `upsert` collapse them into one document) and never lose a
   * scope (the union is recomputed server-side from the document's current value). `grantedScopes`
   * is the union of the already-granted scopes and the newly requested ones, bounded by
   * `allowedScopes` (the client's *current* scopes) so a scope the client has since lost can never
   * be carried forward. Clears `revokedAt`; `grantedAt` is only set on insert.
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
    const now = new Date();
    // DEBT-060 (defense in depth): a concurrent upsert on the unique composite key can, on some
    // MongoDB versions/edge cases, surface as a transient `E11000 duplicate key`. (Mongo ≥4.2 — the
    // compose target — already auto-retries this when the filter is equality on exactly the unique
    // key, which is the case here.) Retry the identical write EXACTLY ONCE on `code === 11000`; the
    // second attempt finds the row the racing writer created and updates it. Any other error, or a
    // second 11000 (persistent), propagates unchanged — no silent swallow, no over-grant (the scope
    // math is identical on both attempts, still `$setIntersection`-bounded by `allowedScopes`).
    try {
      return await this.upsertGrant(
        userId,
        clientId,
        normResource,
        requestedScopes,
        versions,
        allowedScopes,
        now,
      );
    } catch (err) {
      if ((err as { code?: unknown }).code !== 11000) {
        throw err;
      }
      return this.upsertGrant(
        userId,
        clientId,
        normResource,
        requestedScopes,
        versions,
        allowedScopes,
        now,
      );
    }
  }

  /**
   * The atomic update-pipeline round-trip for `grant` (DEBT-027), extracted so the DEBT-060
   * retry-once replays the EXACT same write. Two concurrent grants for the same key converge on one
   * document (unique index + upsert): `grantedScopes` is recomputed server-side from the document's
   * CURRENT value, so neither write loses a scope the other added. The union is bounded by
   * `allowedScopes` (`$setIntersection`) so a scope the client has since lost can never carry forward
   * (fail-closed over-grant guard). `requestedScopes`/`allowedScopes` are wrapped in `$literal`: a
   * pipeline treats a string starting with `$` as a field path, so without `$literal` a scope like
   * `"$grantedScopes"` would be a path (field-path injection). mongoose 9 requires
   * `{ updatePipeline: true }` for an array update; the pipeline is NOT schema-cast, so the `userId`
   * filter is still cast to ObjectId explicitly.
   */
  private async upsertGrant(
    userId: string,
    clientId: string,
    normResource: string,
    requestedScopes: string[],
    versions: ConsentVersions,
    allowedScopes: string[],
    now: Date,
  ): Promise<Consent> {
    const doc = await this.consents
      .findOneAndUpdate(
        { userId: new Types.ObjectId(userId), clientId, resource: normResource },
        [
          {
            $set: {
              grantedScopes: {
                $setIntersection: [
                  {
                    $setUnion: [{ $ifNull: ['$grantedScopes', []] }, { $literal: requestedScopes }],
                  },
                  { $literal: allowedScopes },
                ],
              },
              policyVersion: { $literal: versions.policyVersion },
              termsVersion: { $literal: versions.termsVersion },
              grantedAt: { $ifNull: ['$grantedAt', now] },
              updatedAt: now,
              revokedAt: null,
            },
          },
        ],
        { upsert: true, returnDocument: 'after', updatePipeline: true },
      )
      .lean<Consent>()
      .exec();
    return doc as Consent;
  }
}
