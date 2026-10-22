import "@tanstack/react-start/server-only";
import { createHash, randomBytes } from "node:crypto";
import type { JWTVerifyGetKey } from "jose";
import type { Viewer } from "@/features/auth/viewer-types";
import { ServiceUnavailableError, errorPage, logServerError, unexpectedErrorPage } from "../errors";
import type { Discovery } from "../oidc/discovery";
import { verifyIdToken, type IdTokenPolicy } from "../oidc/id-token";
import {
  TokenEndpointError,
  adminMe,
  exchangeCode,
  refreshGrant,
  revokeRefreshToken,
  userinfo,
  type IdpConfig,
} from "../oidc/idp";
import { sanitizeReturnTo } from "../oidc/return-to";
import { readCookie, serializeCookie, type CookieNames } from "../session/cookies";
import { TX_TTL_SEC, type SessionData, type SessionStore } from "../session/store";

/**
 * fe-admin BFF (plan A4, D2): OIDC confidential client. Tokens live only in the server-side
 * session; the browser gets an opaque cookie and the {@link Viewer} allowlist. Pure request ->
 * response functions over injected dependencies, so the whole flow is testable with a fake IdP.
 */

export interface AuthDeps {
  issuer: string;
  clientId: string;
  appUrl: string;
  adminResource: string;
  idp: IdpConfig;
  discovery: () => Promise<Discovery>;
  jwks: (jwksUri: string) => JWTVerifyGetKey;
  store: SessionStore;
  cookies: CookieNames;
  now: () => number;
}

const SCOPE = "openid email offline_access admin.read admin.write";
/** Refresh when the access token has less than this left. */
export const REFRESH_SKEW_MS = 60_000;
const SIGN_IN_FAILED = "Sign-in failed. Please try again.";
const SESSION_ENDED = "Your session was ended for security reasons. Please sign in again.";
/** Leeway for the step-up `auth_time` check (clock skew between BFF and IdP). */
const AUTH_TIME_SKEW_SEC = 30;

const random = () => randomBytes(32).toString("base64url");
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");
export const ADMIN_ROLES = ["super_admin", "tenant_admin"];

export interface ViewerResult {
  viewer: Viewer | null;
  /** Set-Cookie clearing the session cookie (unknown, tampered or expired session), else null. */
  setCookie: string | null;
}

export interface AccessTokenResult {
  session: { token: string; key: string } | null;
  /** As {@link ViewerResult.setCookie}. */
  setCookie: string | null;
}

export function createAuth(deps: AuthDeps) {
  const { store, cookies, idp } = deps;
  const redirectUri = `${deps.appUrl}/auth/callback`;
  const clearTx = serializeCookie(cookies, cookies.tx, "", 0);
  const clearSid = serializeCookie(cookies, cookies.sid, "", 0);
  const policy = async (): Promise<{ d: Discovery; policy: IdTokenPolicy }> => {
    const d = await deps.discovery();
    return { d, policy: { issuer: deps.issuer, clientId: deps.clientId, jwks: deps.jwks(d.jwks_uri) } };
  };
  const inflight = new Map<string, Promise<SessionData | null>>();

  /** Reads, destroys and revokes an existing session (best-effort revoke). */
  async function endSession(key: string, d: Discovery): Promise<void> {
    const old = await store.get(key);
    await store.destroy(key);
    if (old.status === "ok") await revokeRefreshToken(idp, d, old.data.tokens.refreshToken);
  }

  async function login(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"), deps.appUrl);
    let prev: { sub: string; tenantId: string; key: string } | null = null;
    if (url.searchParams.get("stepup") === "1") {
      // Step-up only makes sense on top of a live session; without one this is a normal login.
      const sid = readCookie(request, cookies.sid);
      if (sid) {
        const key = store.keyFor(sid);
        const current = await store.get(key);
        if (current.status === "ok") prev = { sub: current.data.sub, tenantId: current.data.tenantId, key };
      }
    }
    const d = await deps.discovery();
    const state = random();
    const nonce = random();
    const verifier = random();
    await store.putTx(state, {
      nonce,
      verifier,
      returnTo,
      stepUp: prev !== null,
      prevSub: prev?.sub ?? null,
      prevTenantId: prev?.tenantId ?? null,
      prevKey: prev?.key ?? null,
      createdAt: deps.now(),
    });
    const target = new URL(d.authorization_endpoint);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: deps.clientId,
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      nonce,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
      resource: deps.adminResource,
    };
    if (prev) Object.assign(params, { prompt: "login", max_age: "0" });
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    const headers = new Headers({ location: target.toString(), "cache-control": "no-store" });
    headers.append("set-cookie", serializeCookie(cookies, cookies.tx, state, TX_TTL_SEC));
    return new Response(null, { status: 302, headers });
  }

  /**
   * Any unexpected throw (Redis, discovery) still clears `fea_tx` (DEBT-286) and, once the code was
   * exchanged, revokes the new refresh token (best-effort) before the generic 500/503 page.
   */
  async function callback(request: Request): Promise<Response> {
    const pending: { rt?: string; d?: Discovery } = {};
    try {
      return await handleCallback(request, pending);
    } catch (err) {
      if (pending.rt && pending.d) await revokeRefreshToken(idp, pending.d, pending.rt);
      return unexpectedErrorPage("callback", err, [clearTx]);
    }
  }

  async function handleCallback(request: Request, pending: { rt?: string; d?: Discovery }): Promise<Response> {
    const q = new URL(request.url).searchParams;
    const state = q.get("state");
    const txCookie = readCookie(request, cookies.tx);
    const fail = (status = 400, message = SIGN_IN_FAILED, extra: string[] = []) =>
      errorPage(status, message, [clearTx, ...extra]);
    const stateBound = !!state && !!txCookie && txCookie === state;

    // (1) IdP error: consume the transaction, never echo error / error_description.
    if (q.has("error")) {
      if (stateBound) await store.takeTx(state);
      return fail();
    }
    // (2) state bound to this browser, (3) single-use transaction.
    if (!stateBound) return fail();
    const tx = await store.takeTx(state);
    if (!tx) return fail();
    // (4) RFC 9207 mix-up defence.
    if (q.get("iss") !== deps.issuer) return fail();
    const code = q.get("code");
    if (!code) return fail();

    // (5) code exchange (client_secret_basic + PKCE, no retry).
    const { d, policy: idPolicy } = await policy();
    let tokens;
    try {
      tokens = await exchangeCode(idp, d, { code, verifier: tx.verifier, redirectUri });
    } catch (err) {
      logServerError("callback code exchange", err);
      return fail();
    }
    const newRt = tokens.refresh_token;
    Object.assign(pending, { rt: newRt, d });
    const abort = async (status?: number, message?: string, extra?: string[]) => {
      if (newRt) await revokeRefreshToken(idp, d, newRt);
      return fail(status, message, extra);
    };
    // (7) a refresh token and an ID token are part of the contract.
    if (!newRt || !tokens.id_token) return abort();

    // (6) ID token at the RP (INV-6).
    let claims;
    try {
      claims = await verifyIdToken(tokens.id_token, idPolicy, { nonce: tx.nonce });
    } catch (err) {
      logServerError("callback id_token", err);
      return abort();
    }
    if (tx.stepUp) {
      const authTime = claims.auth_time;
      if (typeof authTime !== "number" || authTime < tx.createdAt / 1000 - AUTH_TIME_SKEW_SEC) return abort();
    }

    // (8) roles from the admin API (source of truth). 403 forbidden => session without roles.
    let me;
    try {
      me = await adminMe(idp, tokens.access_token);
    } catch (err) {
      logServerError("callback admin/me", err);
      return abort();
    }
    if (me && me.sub !== claims.sub) return abort();

    // Step-up must not change identity (DEBT-117): otherwise end both sessions.
    if (tx.stepUp && (claims.sub !== tx.prevSub || !me || me.tenantId !== tx.prevTenantId)) {
      if (tx.prevKey) await endSession(tx.prevKey, d);
      return abort(403, SESSION_ENDED, [clearSid]);
    }

    // (9) email for display (not in the ID token). Failure => null, sub mismatch => abort.
    let email: string | null = null;
    try {
      const info = await userinfo(idp, d, tokens.access_token);
      if (info.sub !== claims.sub) return abort();
      email = info.email;
    } catch (err) {
      logServerError("callback userinfo", err);
    }

    // (10) always a NEW session id (no fixation), cookie set, then the old session goes.
    const now = deps.now();
    const { cookie, key } = await store.create({
      sub: claims.sub,
      tenantId: me?.tenantId ?? "",
      roles: me?.roles ?? [],
      email,
      createdAt: now,
      atExp: now + tokens.expires_in * 1000,
      tokens: { accessToken: tokens.access_token, refreshToken: newRt, idToken: tokens.id_token },
    });
    pending.rt = undefined; // the session owns the RT now
    const oldSid = readCookie(request, cookies.sid);
    const oldKeys = new Set([tx.prevKey, oldSid ? store.keyFor(oldSid) : null]);
    for (const old of oldKeys) {
      if (!old || old === key) continue;
      try {
        await endSession(old, d);
      } catch (err) {
        logServerError("callback end previous session", err);
      }
    }

    // (11) back to the (re-validated) destination.
    const headers = new Headers({
      location: sanitizeReturnTo(tx.returnTo, deps.appUrl),
      "cache-control": "no-store",
    });
    headers.append("set-cookie", clearTx);
    headers.append("set-cookie", serializeCookie(cookies, cookies.sid, cookie));
    return new Response(null, { status: 302, headers });
  }

  /**
   * One refresh per session at a time in this process; waiters share the result. With
   * `staleAccessToken` (the admin API answered 401 to it) the refresh is forced unless another
   * request already replaced that token: a forced caller that finds a refresh in flight waits for
   * it, and only refreshes itself if the token is still the rejected one (RT single-use, run 43 F2).
   */
  async function refresh(key: string, opts: { staleAccessToken?: string } = {}): Promise<SessionData | null> {
    const running = inflight.get(key);
    if (running) {
      const shared = await running;
      if (!opts.staleAccessToken || shared?.tokens.accessToken !== opts.staleAccessToken) return shared;
    }
    let p = inflight.get(key);
    if (!p) {
      p = doRefresh(key, opts.staleAccessToken).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  async function doRefresh(key: string, staleAccessToken?: string): Promise<SessionData | null> {
    // Re-read: another request may have refreshed already (the RT in hand may be spent).
    const current = await store.get(key);
    if (current.status !== "ok") return null;
    const data = current.data;
    const fresh =
      staleAccessToken === undefined
        ? data.atExp - deps.now() >= REFRESH_SKEW_MS
        : data.tokens.accessToken !== staleAccessToken;
    if (fresh) return data;

    const { d, policy: idPolicy } = await policy();
    let t;
    try {
      t = await refreshGrant(idp, d, data.tokens.refreshToken); // never retried: RT is single-use
    } catch (err) {
      if (err instanceof TokenEndpointError && err.status === 400 && err.code === "invalid_grant") {
        await store.destroy(key);
        return null;
      }
      throw new ServiceUnavailableError("Token refresh unavailable", { cause: err });
    }
    const refreshToken = t.refresh_token ?? data.tokens.refreshToken;
    const dropNew = async () => {
      await store.destroy(key);
      if (t.refresh_token) await revokeRefreshToken(idp, d, t.refresh_token);
      return null;
    };
    if (t.id_token) {
      try {
        await verifyIdToken(t.id_token, idPolicy, { sub: data.sub });
      } catch (err) {
        logServerError("refresh id_token", err);
        return dropNew();
      }
    }
    let roles = data.roles;
    let tenantId = data.tenantId;
    try {
      const me = await adminMe(idp, t.access_token);
      if (me && me.sub !== data.sub) return dropNew();
      // A tenant change is an identity change; a session without a tenant yet (not an admin at
      // sign-in, then granted admin) just picks it up (DEBT-287).
      if (me && data.tenantId !== "" && me.tenantId !== "" && me.tenantId !== data.tenantId) return dropNew();
      roles = me ? me.roles : [];
      if (me && data.tenantId === "") tenantId = me.tenantId;
    } catch (err) {
      logServerError("refresh admin/me (roles kept)", err); // tokens must still be saved below
    }
    const next: SessionData = {
      ...data,
      roles,
      tenantId,
      atExp: deps.now() + t.expires_in * 1000,
      tokens: { accessToken: t.access_token, refreshToken, idToken: t.id_token ?? data.tokens.idToken },
    };
    if (!(await store.update(key, next))) {
      // Logged out while we refreshed: do not resurrect the session, kill the new RT.
      if (t.refresh_token) await revokeRefreshToken(idp, d, t.refresh_token);
      return null;
    }
    return next;
  }

  /**
   * The current viewer for a request (guard + header). Refreshes the access token when it is
   * about to expire. Throws {@link ServiceUnavailableError} when Redis or the IdP is down (503,
   * cookie kept, no login redirect loop).
   */
  async function viewer(request: Request): Promise<ViewerResult> {
    const s = await liveSession(request);
    if (!s.data) return { viewer: null, setCookie: s.setCookie };
    const { data } = s;
    return {
      viewer: { sub: data.sub, email: data.email, roles: data.roles, tenantId: data.tenantId },
      setCookie: null,
    };
  }

  /** The request's session with a non-expiring access token (refreshed if needed), or why not. */
  async function liveSession(
    request: Request,
  ): Promise<{ key: string; data: SessionData } | { key: null; data: null; setCookie: string | null }> {
    const sid = readCookie(request, cookies.sid);
    if (!sid) return { key: null, data: null, setCookie: null };
    const key = store.keyFor(sid);
    const found = await store.get(key);
    if (found.status !== "ok") return { key: null, data: null, setCookie: clearSid };
    let data: SessionData | null = found.data;
    if (data.atExp - deps.now() < REFRESH_SKEW_MS) data = await refresh(key);
    if (!data) return { key: null, data: null, setCookie: clearSid };
    return { key, data };
  }

  /**
   * Admin API access token for this request (run 43 F2). Server-only: the token never leaves
   * `src/server/`. Same session rules as {@link viewer} (Redis/IdP down => ServiceUnavailableError).
   */
  async function accessToken(request: Request): Promise<AccessTokenResult> {
    const s = await liveSession(request);
    if (!s.data) return { session: null, setCookie: s.setCookie };
    return { session: { token: s.data.tokens.accessToken, key: s.key }, setCookie: null };
  }

  /** The admin API refused `staleToken` (401): forced single-flight refresh; null => signed out. */
  async function refreshRejected(key: string, staleToken: string): Promise<string | null> {
    return (await refresh(key, { staleAccessToken: staleToken }))?.tokens.accessToken ?? null;
  }

  /**
   * Ends a session the admin API keeps refusing: destroy it, revoke its RT (best-effort) and
   * return the Set-Cookie clearing `fea_sid`.
   */
  async function dropSession(key: string): Promise<string> {
    const old = await store.get(key);
    await store.destroy(key);
    if (old.status === "ok") {
      try {
        await revokeRefreshToken(idp, await deps.discovery(), old.data.tokens.refreshToken);
      } catch (err) {
        logServerError("drop session revoke", err);
      }
    }
    return clearSid;
  }

  /** Same-origin POST only (logout CSRF): Sec-Fetch-Site, else Origin === APP_URL. */
  function sameOrigin(request: Request): boolean {
    const site = request.headers.get("sec-fetch-site");
    if (site !== null) return site === "same-origin";
    return request.headers.get("origin") === deps.appUrl;
  }

  async function logout(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }
    if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
    const headers = new Headers({ "cache-control": "no-store" });
    const sid = readCookie(request, cookies.sid);
    if (!sid) {
      headers.set("location", "/");
      return new Response(null, { status: 303, headers });
    }
    headers.append("set-cookie", clearSid);

    let session: SessionData | null = null;
    const key = store.keyFor(sid);
    try {
      const found = await store.get(key);
      if (found.status === "ok") session = found.data;
      await store.destroy(key);
    } catch (err) {
      // Redis down: still drop the cookie and end the IdP session (IdP asks for confirmation).
      logServerError("logout session read", err);
    }
    let d: Discovery;
    try {
      d = await deps.discovery();
    } catch (err) {
      // The session is already gone: still drop the cookie (DEBT-286).
      return unexpectedErrorPage("logout", err, [clearSid]);
    }
    if (session) await revokeRefreshToken(idp, d, session.tokens.refreshToken);
    const end = new URL(d.end_session_endpoint);
    if (session) end.searchParams.set("id_token_hint", session.tokens.idToken);
    end.searchParams.set("post_logout_redirect_uri", `${deps.appUrl}/`);
    end.searchParams.set("client_id", deps.clientId);
    headers.set("location", end.toString());
    return new Response(null, { status: 303, headers });
  }

  return { login, callback, viewer, logout, accessToken, refreshRejected, dropSession };
}

export type Auth = ReturnType<typeof createAuth>;
