import { env } from "../env.app";
import { discover, type Discovery } from "./discovery";
import { beginLogin } from "./authorize";
import { handleCallback } from "./callback";
import { refreshSession } from "./refresh";
import {
  logout as logoutInner,
  handleLogoutLanding,
  type LogoutLanding,
} from "./logout";
import { createJwks } from "./idToken";
import { createTokenStore, type Session, type TokenStore } from "./tokenStore";
import type { JWTVerifyGetKey } from "jose";

/** The app's single in-memory session store (tokens never leave memory). */
export const tokens: TokenStore = createTokenStore();

let cachedDiscovery: Discovery | null = null;
let cachedJwks: JWTVerifyGetKey | null = null;

/** Fetch + cache discovery (issuer-checked, F5) and the JWKS resolver. */
async function ready(): Promise<{ discovery: Discovery; jwks: JWTVerifyGetKey }> {
  if (!cachedDiscovery) cachedDiscovery = await discover(env.VITE_OIDC_ISSUER);
  if (!cachedJwks) cachedJwks = createJwks(cachedDiscovery.jwks_uri);
  return { discovery: cachedDiscovery, jwks: cachedJwks };
}

/** Start login: redirect the browser to `/authorize`. */
export async function startLogin(): Promise<void> {
  const { discovery } = await ready();
  const { url } = await beginLogin(
    discovery,
    {
      clientId: env.VITE_OIDC_CLIENT_ID,
      redirectUri: env.VITE_OIDC_REDIRECT_URI,
      scope: env.VITE_OIDC_SCOPE,
      resource: env.VITE_OIDC_RESOURCE,
    },
    window.sessionStorage,
  );
  window.location.assign(url);
}

/** Finish login from the `/callback` query string. */
export async function finishLogin(params: URLSearchParams): Promise<Session> {
  const { discovery, jwks } = await ready();
  return handleCallback(
    params,
    {
      clientId: env.VITE_OIDC_CLIENT_ID,
      redirectUri: env.VITE_OIDC_REDIRECT_URI,
      issuer: env.VITE_OIDC_ISSUER,
    },
    { discovery, store: window.sessionStorage, tokens, jwks },
  );
}

/** Single-flight refresh using the stored refresh token. */
export async function refresh(): Promise<Session> {
  const { discovery, jwks } = await ready();
  return refreshSession(
    { clientId: env.VITE_OIDC_CLIENT_ID, issuer: env.VITE_OIDC_ISSUER },
    { discovery, tokens, jwks },
  );
}

/** Clear the session and return the RP-initiated logout URL (or null if anonymous). */
export async function logout(): Promise<string | null> {
  const { discovery } = await ready();
  return logoutInner(
    discovery,
    { postLogoutRedirectUri: env.VITE_OIDC_POST_LOGOUT_URI },
    tokens,
    window.sessionStorage,
  );
}

/**
 * Handle a post-logout landing on the current URL (DEBT-079): verify the returned `state`
 * one-shot/fail-closed and report the stripped query string so the caller can clean the URL.
 */
export function consumeLogout(search: string): LogoutLanding {
  return handleLogoutLanding(window.sessionStorage, search);
}
