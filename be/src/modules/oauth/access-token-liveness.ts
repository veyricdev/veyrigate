import { Types } from 'mongoose';
import type { AccessTokenClaims } from '../keys/token-verifier';

/**
 * The client lookup `/userinfo` and `/introspect` share for access-token liveness: only the one
 * field (`allowedResources`) the liveness check reads, so the helper is decoupled from the full
 * `ClientService`/`Client` shape.
 */
export interface ClientLookup {
  findByClientId(clientId: string): Promise<{ allowedResources: string[] } | null>;
}

/** The user lookup the liveness check needs: existence of `sub` only (never a projection). */
export interface UserExistence {
  exists(id: Types.ObjectId): Promise<boolean>;
}

/**
 * The resource lookup the liveness check needs: map the client's `allowedResources[]` (resourceIds)
 * to the absolute `identifier` URIs of the matching `Resource` documents, so the token's `aud`
 * (a URI) is compared to identifiers — NEVER to a resourceId directly (confused-deputy guard,
 * spec §7). An infrastructure failure MUST propagate (the caller fails closed): it is never
 * swallowed into an empty list that would silently reject a legitimate token.
 */
export interface ResourceLookup {
  identifiersFor(resourceIds: readonly string[]): Promise<string[]>;
}

/**
 * The session lookup the liveness check needs: whether a session `ref` has been actively ended
 * (DEBT-037). `isEnded` is `true` once a logout / device-revoke / password-reset wrote the
 * `sess_end:{ref}` tombstone; a session that merely expired naturally is NOT "ended" and this
 * returns `false`. An infrastructure failure MUST propagate (caller maps it to 5xx / fail-closed).
 */
export interface SessionEndLookup {
  isEnded(ref: string): Promise<boolean>;
}

/** A session `ref`/`sid` is sha256 hex (64 lowercase hex chars). Anything else is malformed. */
const SESSION_REF_RE = /^[0-9a-f]{64}$/;

/**
 * Liveness of a *verified* access token (spec §214, DEBT-037). An access token is self-contained
 * (no `jti` denylist before `exp`), so the live-state signals the IdP still controls are: the
 * issuing session `sid` (when present) has not been actively ended, the client it was issued to
 * still exists AND still allows the resource the `aud` targets, and the `sub` user still exists
 * (with a well-formed `sub`).
 *
 * `aud` is an absolute URI (a `Resource.identifier`), while `client.allowedResources[]` holds
 * stable `resourceId`s (spec §7). The two are reconciled by resolving the client's allowed
 * `resourceId`s to their identifiers (`ResourceLookup.identifiersFor`) and checking membership of
 * `aud` — NEVER by comparing the URI to a `resourceId` directly (confused-deputy guard). An `aud`
 * that is not the identifier of any currently-allowed `Resource` is not live (fail-closed).
 *
 * `sid` semantics (DEBT-037): present `sid` must be a well-formed session ref; a malformed `sid`
 * is not live (no Redis call). An actively-ended session (tombstone) is not live. A session that
 * merely expired naturally is NOT ended, so `offline_access` access tokens minted from a refresh
 * family survive their browser session's idle/absolute expiry. A token with NO `sid` (pre-B4.7
 * families) keeps the old behaviour (client/`aud`/user only). The `sid` check runs BEFORE the
 * Mongo client lookup (Redis is cheaper) and only after the cheap `sub` shape check.
 *
 * Both `/userinfo` (-> 401 `invalid_token` on false) and `/introspect` (-> `active:false` on false)
 * MUST gate on this after `verifyAccessToken`; shared so the two endpoints cannot drift.
 *
 * An infrastructure failure (Redis/DB down) must propagate (the caller maps it to a 5xx /
 * fail-closed), never be swallowed into `false`/`true` here.
 */
export async function isAccessTokenLive(
  claims: Pick<AccessTokenClaims, 'sub' | 'client_id' | 'aud' | 'sid'>,
  clients: ClientLookup,
  users: UserExistence,
  sessions: SessionEndLookup,
  resources: ResourceLookup,
): Promise<boolean> {
  // A non-ObjectId `sub` is not a user this IdP ever issued for - reject before touching the DB
  // (and so `users.exists` never throws a CastError that would look like an infrastructure fault).
  if (!Types.ObjectId.isValid(claims.sub)) {
    return false;
  }
  // Session binding (DEBT-037): a present-but-malformed `sid` is not live without touching Redis; a
  // well-formed `sid` whose session was actively ended (tombstone) is not live. Absent `sid` skips
  // this entirely (pre-B4.7 behaviour). Done before the Mongo lookup — Redis is the cheaper probe.
  if (claims.sid !== undefined) {
    if (!SESSION_REF_RE.test(claims.sid)) {
      return false;
    }
    if (await sessions.isEnded(claims.sid)) {
      return false;
    }
  }
  const client = await clients.findByClientId(claims.client_id);
  if (!client) {
    return false;
  }
  // Compare the token's `aud` (a URI) against the identifiers of the client's allowed resourceIds,
  // never against a resourceId directly (confused-deputy guard, spec §7). A lookup failure
  // propagates (fail-closed) — it is never swallowed into `false`/`true` here.
  const allowedIdentifiers = await resources.identifiersFor(client.allowedResources);
  if (!allowedIdentifiers.includes(claims.aud)) {
    return false;
  }
  return users.exists(new Types.ObjectId(claims.sub));
}
