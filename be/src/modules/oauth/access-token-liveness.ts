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
 * Liveness of a *verified* access token (OPEN-1 -> A, spec §214). An access token is self-contained
 * (no denylist before `exp`), so the only live-state signal the IdP still controls is the current
 * existence of its subjects: the client it was issued to must still exist AND still be allowed the
 * `aud` it targets, and the `sub` user must still exist (with a well-formed `sub`).
 *
 * Both `/userinfo` (-> 401 `invalid_token` on false) and `/introspect` (-> `active:false` on false)
 * MUST gate on this after `verifyAccessToken`; a stale client/resource/user makes a
 * cryptographically valid token no longer trustworthy. Shared so the two endpoints cannot drift.
 *
 * An infrastructure failure (DB down) must propagate (the caller maps it to a 5xx / fail-closed),
 * never be swallowed into `false`/`true` here.
 */
export async function isAccessTokenLive(
  claims: Pick<AccessTokenClaims, 'sub' | 'client_id' | 'aud'>,
  clients: ClientLookup,
  users: UserExistence,
): Promise<boolean> {
  // A non-ObjectId `sub` is not a user this IdP ever issued for - reject before touching the DB
  // (and so `users.exists` never throws a CastError that would look like an infrastructure fault).
  if (!Types.ObjectId.isValid(claims.sub)) {
    return false;
  }
  const client = await clients.findByClientId(claims.client_id);
  if (!client || !client.allowedResources.includes(claims.aud)) {
    return false;
  }
  return users.exists(new Types.ObjectId(claims.sub));
}
