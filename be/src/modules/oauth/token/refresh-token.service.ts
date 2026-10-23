import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { sha256 } from '../../../common/crypto/crypto.util';
import { AuditAction } from '../../security/audit/audit-action.enum';
import { AuditService } from '../../security/audit/audit.service';
import { TokenService, adminTargetForbidden, type TokenResponse } from './token.service';
import { TokenError } from './token.errors';
import { ResourceService } from '../../resources/resource.service';
import type { Client } from '../../clients/client.service';

/**
 * A rotation could not produce a successor. The HTTP layer (Task 3) maps this to `invalid_grant`
 * so the client cannot tell "unknown" from "revoked" (anti-enumeration, spec §9.5). The whole
 * family was already revoked + audited here when the cause was reuse.
 */
export class RefreshRotationError extends Error {
  constructor(message = 'rotation_failed') {
    super(message);
    this.name = 'RefreshRotationError';
  }
}

/** The stored fields the rotation result needs to mint a new access/id token (never the hash). */
export interface RotationResult {
  familyId: string;
  userId: string;
  clientId: string;
  scope: string[];
  resource: string;
  newRefreshToken: string;
  /** Session binding inherited by the family (DEBT-037): set as `sid` on the minted access token so
   * an active logout of the originating session makes it inactive. Undefined for pre-B4.7 families. */
  sessionRef?: string;
  /** `_id` of the doc this rotation consumed (DEBT-215 marker target); never a hash or token. */
  rotatedFromId: Types.ObjectId;
}

/**
 * Request-level context carried into audit records (never contains hash/token). `tenantId` is the
 * tenant of the authenticated client (never request input); only `TOKEN_REUSE_DETECTED` records it
 * today (run 48, rest of DEBT-140 open).
 */
type AuditCtx = { ip?: string; userAgent?: string; requestId?: string; tenantId?: string };

/** A read-only view of the refresh document this service inspects. */
interface RefreshDoc {
  _id: Types.ObjectId;
  familyId: string;
  userId: Types.ObjectId;
  clientId: string;
  scope: string[];
  resource: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  replacedBy?: Types.ObjectId | null;
  reuseDetectedAt?: Date | null;
  familyRevokedAt?: Date | null;
  sessionRef?: string | null;
}

/**
 * Closed union of filters `revokeWhere` accepts. Every variant pins at least one scoping key so
 * the shared revoke core can NEVER run `updateMany({})` (would revoke every family of every user).
 * - `{familyId, clientId}` — reuse detection / `/revoke` (one family of one client).
 * - `{userId}` — global "log out everywhere": all families of the user.
 * - `{userId, sessionRef}` — local logout: only the families minted by this browser session.
 * - `{userId, clientId, resource}` — admin consent revoke (B6.3b): the families of exactly that
 *   `user × client × resource` grant; another resource of the same client survives.
 * - `{clientId}` (no `userId`) — admin disables a client (B6.3c, DEBT-125): every family of it.
 *   `clientId` is globally unique; the caller already checked the client's tenant.
 */
type RevokeFilter =
  | { familyId: string; clientId: string }
  | { userId: string }
  | { userId: string; sessionRef: string }
  | { userId: string; clientId: string; resource: string }
  | { clientId: string };

/** Admin metadata of one refresh family (B6.3b). Never a hash, parent/successor or device data. */
export interface FamilySummary {
  familyId: string;
  clientId: string;
  resource: string;
  scope: string[];
  createdAt: Date;
  lastRotatedAt: Date;
  expiresAt: Date;
  active: boolean;
  revokedAt: Date | null;
}

/**
 * Refresh-token rotation, reuse detection and family revocation (spec §9.5, INV-10/11/12).
 *
 * `rotate` is strict: a refresh value is single-use, the swap is one atomic
 * `findOneAndUpdate` keyed by `tokenHash` (never `_id`), and a replay of an already-rotated
 * value revokes the whole family immediately (no grace period). Everything is bound to the
 * authenticated `clientId` so a client can never rotate — or trigger a revoke of — another
 * client's family (confused-deputy / cross-client DoS).
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    @InjectModel('RefreshToken') private readonly refreshTokens: Model<Record<string, unknown>>,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly resources: ResourceService,
  ) {}

  /**
   * Full refresh-token grant (spec §8/§9.3/§9.5, INV-12): validate the requested scope/resource
   * against the original grant WITHOUT writing, then atomically rotate, then sign new tokens and
   * audit `TOKEN_REFRESHED`.
   *
   * Scope may only be narrowed — a requested scope outside the original is `invalid_scope` and no
   * rotation happens (INV-13 spirit: a bad request must not burn a valid refresh token). A body
   * `resource` that differs from the bound resource is `invalid_target`. The minted descendant
   * keeps the ORIGINAL scope (the family grant never widens or permanently narrows, INV-12); only
   * the access token carries the narrowed scope. Reuse/concurrency failures surface as
   * `RefreshRotationError` (mapped to `invalid_grant` by the controller); sign/audit failure after
   * the atomic swap fails closed (500, the token is gone → re-login; accepted, DEBT-032).
   *
   * DEBT-207 (run 36 G4): `recheck(userId)` is REQUIRED and runs right after a successful `rotate`
   * and before signing. A returned reason (client disabled / admin lock / membership gone) revokes
   * the whole family, audits `TOKEN_REFRESHED failure <reason>` and throws `RefreshRotationError`
   * (opaque invalid_grant). A thrown recheck revokes best-effort, audits `recheck_failed`
   * best-effort and rethrows (500, fail-closed). "Rotate, then re-read" mirrors the revoking
   * side ("write state, then sweep"), so no interleaving leaves a usable successor.
   */
  async issueForRefresh(
    value: string,
    client: Pick<
      Client,
      'clientId' | 'allowedResources' | 'clientType' | 'tokenEndpointAuthMethod' | 'tenantId'
    >,
    request: { scope?: string; resource?: string },
    recheck: (userId: string) => Promise<string | null>,
    audit: AuditCtx = {},
  ): Promise<TokenResponse> {
    const tokenHash = sha256(value);
    const now = new Date();

    // Read-only pre-check bound to this client AND the ACTIVE state (revokedAt:null, unexpired).
    // A missing / another-client's / already-revoked / expired token skips the scope check so the
    // atomic rotate classifies it: a replay of a rotated value still triggers reuse detection even
    // when the body carries a bad scope (otherwise invalid_scope would silence the alarm, 🟡-1).
    // `resource ∈ allowedResources` mirrors the atomic rotate filter (INV-14): a token whose
    // resource the client lost skips the scope check so it classifies as invalid_grant at rotate,
    // not invalid_scope (consistency; harmless since only the owning client could see either).
    // `RefreshToken.resource` stores the resource URI (identifier), while `allowedResources[]`
    // holds resourceIds (spec §7), so the client's allowed resourceIds are resolved to their
    // identifiers first and the URI is matched against those — never a resourceId directly
    // (confused-deputy guard). A Mongo failure here propagates (fail-closed, no rotation).
    // DEBT-172/174: a non-admin-capable client never refreshes an `aud=admin` family: the admin
    // identifier is dropped from its allowlist, so the token classifies as invalid (invalid_grant)
    // exactly like a resource the client lost (not reuse; nothing is rotated or burned).
    const allowedIdentifiers = (
      await this.resources.identifiersFor(client.allowedResources)
    ).filter((id) => !adminTargetForbidden(client, id, this.tokens.adminResource));
    const original = (await this.refreshTokens
      .findOne({
        tokenHash,
        clientId: client.clientId,
        revokedAt: null,
        expiresAt: { $gt: now },
        resource: { $in: allowedIdentifiers },
      })
      .lean()
      .exec()) as RefreshDoc | null;

    let effectiveScope: string[] | undefined;
    if (original) {
      if (request.resource !== undefined && request.resource !== original.resource) {
        throw new TokenError('invalid_target');
      }
      if (request.scope !== undefined) {
        // RFC 6749 §6: a requested scope may only narrow the original grant. Dedupe; an empty
        // scope (e.g. `scope=`) is treated as "no scope parameter" → keep the original grant.
        const requested = [...new Set(request.scope.split(' ').filter(Boolean))];
        if (requested.length > 0) {
          const granted = new Set(original.scope);
          if (!requested.every((s) => granted.has(s))) {
            throw new TokenError('invalid_scope');
          }
          effectiveScope = requested;
        }
      }
    }

    // Atomic single-use rotation is the source of truth (re-validates active/unexpired/owner/
    // resource). Any invalid/reuse result throws here before any token is signed.
    // DEBT-105: hand the identifiers resolved for the pre-check to rotate (one lookup per refresh).
    const result = await this.rotate(
      value,
      client,
      { ...audit, tenantId: client.tenantId },
      allowedIdentifiers,
    );
    await this.recheckAfterRotate(result, recheck, audit);

    // Access token uses the narrowed scope when the client asked to narrow; otherwise the full
    // granted scope. The descendant refresh keeps the original scope (done inside `rotate`).
    const accessScope = effectiveScope ?? result.scope;
    const { accessToken, idToken } = await this.tokens.signTokensForRefresh({
      userId: result.userId,
      clientId: result.clientId,
      resource: result.resource,
      effectiveScope: accessScope,
      sessionRef: result.sessionRef,
    });

    await this.audit.record({
      // `user`: a successful refresh acts on behalf of the resource owner (unlike
      // TOKEN_REUSE_DETECTED / TOKEN_REVOKED which are client-driven security events).
      actorType: 'user',
      actorId: result.userId,
      clientId: result.clientId,
      action: AuditAction.TOKEN_REFRESHED,
      result: 'success',
      ip: audit.ip,
      userAgent: audit.userAgent,
      requestId: audit.requestId,
      metadata: {
        resource: result.resource,
        scope: accessScope.join(' '),
        familyId: result.familyId,
      },
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.tokens.accessTokenLifetime,
      scope: accessScope.join(' '),
      ...(idToken ? { id_token: idToken } : {}),
      refresh_token: result.newRefreshToken,
    };
  }

  /** DEBT-207: current-state re-check of a refresh after `rotate` (see `issueForRefresh`). */
  private async recheckAfterRotate(
    result: RotationResult,
    recheck: (userId: string) => Promise<string | null>,
    audit: AuditCtx,
  ): Promise<void> {
    const refuse = (reason: string) =>
      this.audit.record({
        actorType: 'user',
        actorId: result.userId,
        clientId: result.clientId,
        action: AuditAction.TOKEN_REFRESHED,
        result: 'failure',
        reason,
        ip: audit.ip,
        userAgent: audit.userAgent,
        requestId: audit.requestId,
        metadata: { resource: result.resource, familyId: result.familyId },
      });
    // DEBT-215: once the family is dead, unlink the consumed doc from its (undelivered) successor so
    // an RP retry of the refused token is a plain invalid_grant, not a false TOKEN_REUSE_DETECTED.
    // Only AFTER a successful revoke: if the revoke failed, the successor may be alive and a replay
    // must still sweep it through reuse detection (DEBT-067). Best effort: a failure only means a
    // false reuse alert later, the family is already dead.
    const unlinkSuccessor = () =>
      this.refreshTokens
        .updateOne(
          { _id: result.rotatedFromId, replacedBy: { $ne: null } },
          { $set: { replacedBy: null } },
        )
        .exec()
        .then(
          () => undefined,
          (err: unknown) =>
            this.logger.warn(`refused refresh: unlink failed: ${(err as Error).message}`),
        );
    let reason: string | null;
    try {
      reason = await recheck(result.userId);
    } catch (err) {
      const revoked = await this.revokeFamily(result.familyId, result.clientId, new Date()).then(
        () => true,
        () => false,
      );
      if (revoked) await unlinkSuccessor();
      await refuse('recheck_failed').catch(() => undefined);
      throw err;
    }
    if (reason === null) return;
    try {
      await this.revokeFamily(result.familyId, result.clientId, new Date());
    } catch (err) {
      await refuse(reason).catch(() => undefined); // DEBT-067: keep the refusal audit.
      throw err;
    }
    await unlinkSuccessor();
    await refuse(reason);
    throw new RefreshRotationError();
  }

  /**
   * `POST /revoke` core (RFC 7009): revoke the whole family of the refresh token `value`, bound to
   * `clientId` (IDOR guard — a client can only revoke its own tokens). A non-refresh / unknown /
   * other-client value is a no-op (the controller still returns 200, no enumeration). An audit
   * `TOKEN_REVOKED` is written only when something actually changed (`modifiedCount > 0`), with
   * no hash/token in the metadata. Mongo/audit errors propagate so the controller fails closed.
   */
  async revokeByToken(value: string, clientId: string, audit: AuditCtx = {}): Promise<void> {
    const tokenHash = sha256(value);
    const doc = (await this.refreshTokens
      .findOne({ tokenHash, clientId })
      .lean()
      .exec()) as RefreshDoc | null;
    if (!doc) {
      return; // unknown, access token (wrong type), or another client's token: no-op 200.
    }

    const now = new Date();
    const modified = await this.revokeFamily(doc.familyId, clientId, now);
    if (modified > 0) {
      await this.audit.record({
        actorType: 'client',
        actorId: clientId,
        clientId,
        action: AuditAction.TOKEN_REVOKED,
        result: 'success',
        ip: audit.ip,
        userAgent: audit.userAgent,
        requestId: audit.requestId,
        metadata: { familyId: doc.familyId, count: modified },
      });
    }
  }

  /**
   * Atomically consume `value` for `client` and mint its single successor. The atomic filter
   * requires the token to be active (`revokedAt=null`), unexpired, bound to this `clientId`, and
   * for a `resource` the client is still allowed to target (INV-14). On a lost concurrency race
   * — or any replay of an already-rotated value — the family is revoked (strict rotation) and a
   * `RefreshRotationError` is thrown; genuinely invalid/unknown/expired values also throw
   * `RefreshRotationError` without touching any family.
   *
   * Race hardening (INV-11, mark-then-check): EVERY family revoke — reuse AND `/revoke` — stamps
   * `familyRevokedAt` on the family BEFORE it revokes it (see `revokeFamily`). After minting the
   * successor S we re-read the parent's `familyRevokedAt`; if it is set, the concurrent revoke
   * either already saw S or will see it (its revoke `updateMany` runs strictly after the stamp this
   * read observed), so to close the window we revoke S here and fail closed. This guarantees no
   * descendant survives a revoked family for ANY interleaving, without needing a transaction.
   */
  async rotate(
    value: string,
    client: { clientId: string; allowedResources: string[] },
    audit: AuditCtx = {},
    /** Identifiers of `client.allowedResources` already resolved by the caller (DEBT-105); resolved
     * here when omitted. The atomic filter below is the same either way. */
    allowedIdentifiers?: string[],
  ): Promise<RotationResult> {
    const tokenHash = sha256(value);
    const now = new Date();
    const successorId = new Types.ObjectId();

    // Atomic single-use swap: only an active, unexpired, client-owned token whose resource is
    // still allowed flips to revoked here; the same filter prevents a second winner. The client's
    // allowed resourceIds are resolved to identifiers so the stored `resource` URI is matched
    // against identifiers, never a resourceId directly (confused-deputy guard, spec §7). A Mongo
    // failure propagates (fail-closed): the rotate never runs, so no token is burned.
    const identifiers =
      allowedIdentifiers ?? (await this.resources.identifiersFor(client.allowedResources));
    const old = (await this.refreshTokens
      .findOneAndUpdate(
        {
          tokenHash,
          clientId: client.clientId,
          revokedAt: null,
          expiresAt: { $gt: now },
          resource: { $in: identifiers },
        },
        { $set: { revokedAt: now, replacedBy: successorId } },
        { new: false },
      )
      .lean()
      .exec()) as RefreshDoc | null;

    if (!old) {
      await this.classifyMiss(tokenHash, client.clientId, now, audit);
      // classifyMiss throws for reuse; reaching here means a plain invalid value.
      throw new RefreshRotationError();
    }

    // Descendant inherits family + the original absolute lifetime (no sliding, Q6) + scope/
    // resource of the grant (never widened — Task 3 narrows the access token, not the family).
    const minted = await this.tokens.insertRefreshToken({
      _id: successorId,
      userId: old.userId.toHexString(),
      clientId: old.clientId,
      scope: old.scope,
      resource: old.resource,
      familyId: old.familyId,
      parentId: old._id,
      issuedAt: now,
      expiresAt: old.expiresAt,
      // Inherit the session binding (like familyId) so a local logout keeps reaching the family
      // after any number of rotations (B4.7). Undefined for pre-B4.7 families (no binding).
      sessionRef: old.sessionRef ?? undefined,
      ip: audit.ip,
      userAgent: audit.userAgent,
    });

    // Race close (INV-11): if ANY concurrent family revoke (reuse OR /revoke) has stamped
    // `familyRevokedAt`, our just-minted successor S may have been born after that request's revoke
    // `updateMany` and would otherwise survive. `familyRevokedAt` is stamped by EVERY revoke path
    // before its revoke updateMany (see `revokeFamily`), so re-reading it here closes the window for
    // both paths: revoke S and fail closed (the client must re-login). Reads/writes are on the
    // primary (no `readPreference`/`writeConcern` override on this model), so the stamp this read
    // observes — or the revoke updateMany that follows it — is linearizable w.r.t. our insert.
    const parent = (await this.refreshTokens
      .findOne({ _id: old._id }, { familyRevokedAt: 1 })
      .lean()
      .exec()) as Pick<RefreshDoc, 'familyRevokedAt'> | null;
    // Fail-closed (DEBT-036): a missing parent (concurrently deleted — e.g. TTL expiry) is treated
    // like a revoked family, so the just-minted successor never survives an ambiguous read.
    if (!parent || parent.familyRevokedAt != null) {
      await this.refreshTokens
        .updateOne({ _id: successorId, revokedAt: null }, { $set: { revokedAt: now } })
        .exec();
      throw new RefreshRotationError();
    }

    return {
      familyId: old.familyId,
      userId: old.userId.toHexString(),
      clientId: old.clientId,
      scope: old.scope,
      resource: old.resource,
      newRefreshToken: minted.token,
      // Carry the family's session binding out so the minted access token gets `sid` (DEBT-037).
      sessionRef: old.sessionRef ?? undefined,
      rotatedFromId: old._id,
    };
  }

  /**
   * The atomic swap missed. Re-read bound to this client to classify: a doc that is BOTH revoked
   * AND already replaced is a replay of a rotated token → reuse → revoke the family + alert. A
   * doc that is merely expired, or revoked-without-replacement (an earlier `/revoke`), or for a
   * resource the client lost, or simply not this client's token (null) is invalid, NOT reuse →
   * so an attacker's junk value never reveals or tears down another family.
   */
  private async classifyMiss(
    tokenHash: string,
    clientId: string,
    now: Date,
    audit: AuditCtx,
  ): Promise<void> {
    const doc = (await this.refreshTokens
      .findOne({ tokenHash, clientId })
      .lean()
      .exec()) as RefreshDoc | null;

    const isReuse = doc != null && doc.revokedAt != null && doc.replacedBy != null;
    if (!isReuse) {
      return; // plain invalid: unknown, expired, revoked-by-/revoke, or wrong resource.
    }

    await this.revokeFamily(doc.familyId, clientId, now, { reuse: true, audit });
    throw new RefreshRotationError();
  }

  /**
   * Revoke every still-active member of a family in one write (fail-closed). Bound to
   * `clientId` so it can only ever touch the caller's own family. When `reuse` is set the
   * replayed value marks the family `reuseDetectedAt` BEFORE revoking (so a concurrent `rotate`
   * that re-reads the stamp after minting can self-revoke its successor — INV-11 race close) and
   * a `TOKEN_REUSE_DETECTED` alert is recorded; the audit metadata never carries the hash or
   * token value (exposure budget). Returns the number of documents actually revoked.
   */
  /**
   * Revoke the family just minted for an authorization-code grant whose browser session was
   * terminated during the code's exchange window (DEBT-051, §15 inv. 29). Audits `TOKEN_REVOKED`
   * with `reason:'session_ended'` and the revoked `count` — a client-driven security event (the
   * code was exchanged after a logout). The metadata carries NO `familyId`/`sessionRef`/token
   * (correlatable identifiers stay out of the audit log). Errors propagate so the controller
   * fails closed. Returns the number of family members revoked.
   */
  async revokeFamilyForEndedSession(
    familyId: string,
    clientId: string,
    now: Date,
    audit: AuditCtx = {},
  ): Promise<number> {
    const modified = await this.revokeFamily(familyId, clientId, now);
    await this.audit.record({
      actorType: 'client',
      actorId: clientId,
      clientId,
      action: AuditAction.TOKEN_REVOKED,
      result: 'success',
      ip: audit.ip,
      userAgent: audit.userAgent,
      requestId: audit.requestId,
      metadata: { reason: 'session_ended', count: modified },
    });
    return modified;
  }

  async revokeFamily(
    familyId: string,
    clientId: string,
    now: Date,
    opts: { reuse?: boolean; audit?: AuditCtx } = {},
  ): Promise<number> {
    const modified = await this.revokeWhere({ familyId, clientId }, now, { reuse: opts.reuse });

    if (opts.reuse) {
      await this.audit.record({
        actorType: 'client',
        actorId: clientId,
        tenantId: opts.audit?.tenantId,
        clientId,
        action: AuditAction.TOKEN_REUSE_DETECTED,
        result: 'failure',
        ip: opts.audit?.ip,
        userAgent: opts.audit?.userAgent,
        requestId: opts.audit?.requestId,
        metadata: { familyId, count: modified },
      });
    }
    return modified;
  }

  /**
   * Revoke every still-active member of ALL families a user owns (global "log out everywhere",
   * B4.7). Scoped to `userId` only — the destructive scope is decided by the caller's
   * authenticated session, never by client input. Returns the number of documents revoked.
   */
  async revokeAllForUser(userId: string, now: Date): Promise<number> {
    return this.revokeWhere({ userId }, now);
  }

  /**
   * Revoke every still-active member of the families minted by a single browser session (local
   * logout, B4.7). `sessionRef` = sha256(cookie id) carried on each RefreshToken; another device
   * of the same user has a different `sessionRef` so its tokens survive. Returns documents revoked.
   */
  async revokeForSession(userId: string, sessionRef: string, now: Date): Promise<number> {
    return this.revokeWhere({ userId, sessionRef }, now);
  }

  /**
   * Revoke the families of one consent grant `user × client × resource` (admin consent revoke,
   * B6.3b) — so an `offline_access` client cannot keep refreshing after its consent is gone.
   */
  async revokeForConsent(
    userId: string,
    clientId: string,
    resource: string,
    now: Date,
  ): Promise<number> {
    return this.revokeWhere({ userId, clientId, resource }, now);
  }

  /**
   * Revoke every family of a client (admin disable, B6.3c, DEBT-125) so enabling it again does not
   * revive old refresh tokens. Idempotent (a repeated disable is the retry path).
   */
  async revokeForClient(clientId: string, now: Date): Promise<number> {
    return this.revokeWhere({ clientId }, now);
  }

  /** Distinct `clientId`s the user holds refresh tokens for (admin: resolve the tenant's clients). */
  async distinctClientIds(userId: string): Promise<string[]> {
    return (await this.refreshTokens
      .distinct('clientId', { userId: new Types.ObjectId(userId) })
      .exec()) as string[];
  }

  /**
   * Admin list (B6.3b): one summary per family of `userId` restricted to `clientIds` (the caller
   * passes only clients of the token's tenant), ordered by `familyId`, strictly after the cursor.
   * Uses the `{userId, clientId}` index. Members without `revokedAt` count as live (the field is
   * absent until a revoke, so it is read through `$ifNull`).
   */
  async listFamilies(
    userId: string,
    clientIds: string[],
    after: string | undefined,
    limit: number,
    now: Date,
  ): Promise<FamilySummary[]> {
    if (clientIds.length === 0) return [];
    return this.refreshTokens
      .aggregate<FamilySummary>([
        {
          $match: {
            userId: new Types.ObjectId(userId),
            clientId: { $in: clientIds },
            ...(after !== undefined ? { familyId: { $gt: after } } : {}),
          },
        },
        {
          $group: {
            _id: '$familyId',
            clientId: { $first: '$clientId' },
            resource: { $first: '$resource' },
            scope: { $first: '$scope' },
            createdAt: { $min: '$issuedAt' },
            lastRotatedAt: { $max: '$issuedAt' },
            expiresAt: { $max: '$expiresAt' },
            revokedAt: { $max: '$familyRevokedAt' },
            active: {
              $max: {
                $and: [
                  { $eq: [{ $ifNull: ['$revokedAt', null] }, null] },
                  { $gt: ['$expiresAt', now] },
                ],
              },
            },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: limit },
        {
          $project: {
            _id: 0,
            familyId: '$_id',
            clientId: 1,
            resource: 1,
            scope: 1,
            createdAt: 1,
            lastRotatedAt: 1,
            expiresAt: 1,
            active: 1,
            revokedAt: { $ifNull: ['$revokedAt', null] },
          },
        },
      ])
      .exec();
  }

  /** `clientId` of the family `familyId` owned by `userId`, or null (admin family revoke). */
  async findFamilyClient(familyId: string, userId: string): Promise<string | null> {
    const doc = (await this.refreshTokens
      .findOne({ familyId, userId: new Types.ObjectId(userId) }, { clientId: 1 })
      .lean()
      .exec()) as { clientId: string } | null;
    return doc?.clientId ?? null;
  }

  /**
   * The ONE place that revokes RefreshToken documents (DEBT-034). Enforces INV-11 stamp-first
   * ordering for ANY revoke path: stamp `familyRevokedAt` on every still-live match BEFORE the
   * `revokedAt` write, so a concurrent `rotate` that re-reads the stamp after minting its
   * successor self-revokes it (see `rotate`/`revokeFamily` comments). Idempotent via the
   * `familyRevokedAt:null` / `revokedAt:null` filters. Returns the number of docs revoked.
   *
   * Guard (tech-lead fold #5): the filter is a closed union that always carries a scoping key, so
   * an empty-filter `updateMany({})` is impossible; we still assert at runtime. `userId` is cast to
   * `ObjectId` because `updateMany` does not run Mongoose's schema casting on the raw filter, so a
   * string `userId` would match zero docs (stored as `ObjectId`) and silently revoke nothing.
   */
  private async revokeWhere(
    filter: RevokeFilter,
    now: Date,
    opts: { reuse?: boolean } = {},
  ): Promise<number> {
    const scope = this.buildRevokeScope(filter);

    await this.refreshTokens
      .updateMany({ ...scope, familyRevokedAt: null }, { $set: { familyRevokedAt: now } })
      .exec();

    if (opts.reuse) {
      // Reuse additionally records the detection timestamp (idempotent); drives TOKEN_REUSE_DETECTED.
      await this.refreshTokens
        .updateMany({ ...scope, reuseDetectedAt: null }, { $set: { reuseDetectedAt: now } })
        .exec();
    }

    const res = await this.refreshTokens
      .updateMany({ ...scope, revokedAt: null }, { $set: { revokedAt: now } })
      .exec();
    return (res as { modifiedCount?: number }).modifiedCount ?? 0;
  }

  /** Turn a `RevokeFilter` into a concrete Mongo query, failing closed on any empty/invalid scope. */
  private buildRevokeScope(filter: RevokeFilter): Record<string, unknown> {
    if ('familyId' in filter) {
      if (!filter.familyId || !filter.clientId) {
        throw new Error('revokeWhere requires both familyId and clientId');
      }
      return { familyId: filter.familyId, clientId: filter.clientId };
    }
    if (!('userId' in filter)) {
      if (typeof filter.clientId !== 'string' || !filter.clientId) {
        throw new Error('revokeWhere requires a non-empty clientId');
      }
      return { clientId: filter.clientId };
    }
    if (!filter.userId) {
      throw new Error('revokeWhere requires a userId');
    }
    const scope: Record<string, unknown> = { userId: new Types.ObjectId(filter.userId) };
    if ('sessionRef' in filter) {
      if (!filter.sessionRef) {
        throw new Error('revokeWhere requires a non-empty sessionRef');
      }
      scope.sessionRef = filter.sessionRef;
    }
    if ('resource' in filter) {
      if (!filter.clientId || typeof filter.resource !== 'string') {
        throw new Error('revokeWhere requires clientId and resource');
      }
      scope.clientId = filter.clientId;
      scope.resource = filter.resource;
    }
    return scope;
  }
}
