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
 * still exists AND still allows the `aud` it targets, and the `sub` user still exists (with a
 * well-formed `sub`).
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
  if (!client || !client.allowedResources.includes(claims.aud)) {
    return false;
  }
  return users.exists(new Types.ObjectId(claims.sub));
}
