import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { sha256 } from '../../../common/crypto/crypto.util';
import { AuditAction } from '../../security/audit/audit-action.enum';
import { AuditService } from '../../security/audit/audit.service';
import { TokenService, type TokenResponse } from './token.service';
import { TokenError } from './token.errors';

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
}

/** Request-level context carried into audit records (never contains hash/token). */
type AuditCtx = { ip?: string; userAgent?: string; requestId?: string };

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
  constructor(
    @InjectModel('RefreshToken') private readonly refreshTokens: Model<Record<string, unknown>>,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
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
   */
  async issueForRefresh(
    value: string,
    client: { clientId: string; allowedResources: string[] },
    request: { scope?: string; resource?: string },
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
    const original = (await this.refreshTokens
      .findOne({
        tokenHash,
        clientId: client.clientId,
        revokedAt: null,
        expiresAt: { $gt: now },
        resource: { $in: client.allowedResources },
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
    const result = await this.rotate(value, client, audit);

    // Access token uses the narrowed scope when the client asked to narrow; otherwise the full
    // granted scope. The descendant refresh keeps the original scope (done inside `rotate`).
    const accessScope = effectiveScope ?? result.scope;
    const { accessToken, idToken } = await this.tokens.signTokensForRefresh({
      userId: result.userId,
      clientId: result.clientId,
      resource: result.resource,
      effectiveScope: accessScope,
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
  ): Promise<RotationResult> {
    const tokenHash = sha256(value);
    const now = new Date();
    const successorId = new Types.ObjectId();

    // Atomic single-use swap: only an active, unexpired, client-owned token whose resource is
    // still allowed flips to revoked here; the same filter prevents a second winner.
    const old = (await this.refreshTokens
      .findOneAndUpdate(
        {
          tokenHash,
          clientId: client.clientId,
          revokedAt: null,
          expiresAt: { $gt: now },
          resource: { $in: client.allowedResources },
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
    if (parent?.familyRevokedAt != null) {
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
  async revokeFamily(
    familyId: string,
    clientId: string,
    now: Date,
    opts: { reuse?: boolean; audit?: AuditCtx } = {},
  ): Promise<number> {
    // Stamp `familyRevokedAt` FIRST on EVERY revoke path (reuse AND /revoke), before the revoke
    // `updateMany`. INV-11 race close with a concurrent `rotate` A (swap → insert S → re-read):
    //   - if A's re-read of `familyRevokedAt` runs AFTER this stamp → A observes it and self-revokes S;
    //   - if A's re-read runs BEFORE this stamp, then this stamp (hence the revoke updateMany below,
    //     which runs strictly after the stamp) runs after A's re-read, which runs after A inserted S,
    //     so the revoke updateMany sees S (revokedAt:null) and revokes it.
    // Either way no descendant survives a revoked family — true for ANY interleaving, no transaction.
    // Idempotent via the `familyRevokedAt: null` filter so a second /revoke is a no-op here.
    await this.refreshTokens
      .updateMany({ familyId, clientId, familyRevokedAt: null }, { $set: { familyRevokedAt: now } })
      .exec();

    if (opts.reuse) {
      // Reuse additionally records the detection timestamp (idempotent); drives TOKEN_REUSE_DETECTED.
      await this.refreshTokens
        .updateMany(
          { familyId, clientId, reuseDetectedAt: null },
          { $set: { reuseDetectedAt: now } },
        )
        .exec();
    }

    const res = await this.refreshTokens
      .updateMany({ familyId, clientId, revokedAt: null }, { $set: { revokedAt: now } })
      .exec();
    const modified = (res as { modifiedCount?: number }).modifiedCount ?? 0;

    if (opts.reuse) {
      await this.audit.record({
        actorType: 'client',
        actorId: clientId,
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
}
