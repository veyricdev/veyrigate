import { env } from "../env.app";
import { discover, type Discovery } from "./discovery";
import { beginLogin, type AuthorizeConfig } from "./authorize";
import { handleCallback } from "./callback";
import { refreshSession } from "./refresh";
import { postToken } from "./token-exchange";
import {
  logout as logoutInner,
  handleLogoutLanding,
  type LogoutLanding,
} from "./logout";
import { createJwks } from "./idToken";
import { createTokenStore, type Session, type TokenStore } from "./tokenStore";
import { saveReturnTo, takeReturnTo } from "./returnToStore";
import { revokeRefreshToken } from "./revoke";
import { readTransient } from "./transient";
import {
  handleAudProbeCallback,
  takeProbeResult as takeProbeResultInner,
  PROBE_RELOGIN_KEY,
  type ProbeResult,
} from "./probe";
import {
  buildScenarioUrl,
  checkStateTamper,
  findLabScenario,
  recordLabCallback,
  tamperState,
  takeLabResult as takeLabResultInner,
  type LabResult,
} from "./lab";
import type { JWTVerifyGetKey } from "jose";

/** RFC 8707 resource indicator used for the wrong-`aud` security-lab probe (Q-24.1: `other`). */
const PROBE_RESOURCE = `${env.VITE_OIDC_ISSUER.replace(/\/+$/, "")}/other/`;

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

/**
 * Start login: redirect the browser to `/authorize`. The optional `returnTo` (the page the user
 * wanted) is persisted in a sessionStorage transient — NOT through the OAuth `state` — and is
 * sanitized on write; `/callback` reads and re-sanitizes it to decide where to land.
 */
export async function startLogin(returnTo?: string, opts: { prompt?: string } = {}): Promise<void> {
  const { discovery } = await ready();
  if (returnTo !== undefined) saveReturnTo(window.sessionStorage, returnTo);
  const { url } = await beginLogin(
    discovery,
    {
      clientId: env.VITE_OIDC_CLIENT_ID,
      redirectUri: env.VITE_OIDC_REDIRECT_URI,
      scope: env.VITE_OIDC_SCOPE,
      resource: env.VITE_OIDC_RESOURCE,
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
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

/**
 * Read + consume the pending post-login `returnTo` (one-shot), re-sanitized against the current
 * origin. Returns a guaranteed-safe same-origin path (`/` when absent or invalid). Called by the
 * `/callback` loader to redirect the user back to where they started.
 */
export function consumeReturnTo(): string {
  return takeReturnTo(window.sessionStorage);
}

/**
 * Start the wrong-`aud` security-lab probe (Task 3, INV-8). This is a redirect CHAIN that leaves
 * the main session intact:
 *  1. Best-effort revoke the current refresh token so abandoning this session leaves no orphaned
 *     family (failure is ignored — the probe continues).
 *  2. Redirect to `/authorize` for the WRONG resource (`other`) with scope `openid` only, tagging
 *     the transient `purpose:"aud-probe"`. The IdP cookie is still valid, so there is no re-login
 *     (the first time, the user approves consent for `other`).
 *
 * The `/callback` detects the `aud-probe` transient and runs {@link finishAudProbe}, then restores
 * the main session with `prompt=none` (see {@link restoreSessionSilently}).
 */
export async function startAudProbe(): Promise<void> {
  const { discovery } = await ready();

  // (1) Best-effort revoke the current refresh token before we walk away from this session.
  const session = tokens.get();
  if (session?.refreshToken && discovery.revocation_endpoint) {
    await revokeRefreshToken(
      discovery.revocation_endpoint,
      session.refreshToken,
      env.VITE_OIDC_CLIENT_ID,
    );
  }

  // (2) Authorize for the WRONG resource with scope `openid` only, tagged as the probe.
  const { url } = await beginLogin(
    discovery,
    {
      clientId: env.VITE_OIDC_CLIENT_ID,
      redirectUri: env.VITE_OIDC_REDIRECT_URI,
      scope: "openid",
      resource: PROBE_RESOURCE,
      purpose: "aud-probe",
    },
    window.sessionStorage,
  );
  window.location.assign(url);
}

/** True when the pending `/callback` belongs to the wrong-`aud` probe (not an ordinary login). */
export function isAudProbePending(): boolean {
  return readTransient(window.sessionStorage)?.purpose === "aud-probe";
}

/**
 * Finish the wrong-`aud` probe at `/callback`: exchange the `other` token, call `/demo/me` with it,
 * record ONLY the status to sessionStorage, and discard the token. Returns the recorded result.
 */
export async function finishAudProbe(params: URLSearchParams): Promise<ProbeResult> {
  const { discovery, jwks } = await ready();
  return handleAudProbeCallback(
    params,
    {
      clientId: env.VITE_OIDC_CLIENT_ID,
      redirectUri: env.VITE_OIDC_REDIRECT_URI,
      issuer: env.VITE_OIDC_ISSUER,
      demoApiUrl: env.VITE_DEMO_API_URL,
      probeResource: PROBE_RESOURCE,
    },
    { discovery, store: window.sessionStorage, jwks },
  );
}

/**
 * Rebuild the MAIN session after the probe using `prompt=none` (silent, no UI). Because the IdP
 * cookie is still valid this normally returns a fresh code silently. A `login_required` /
 * `consent_required` / `interaction_required` response falls back to an interactive login — but
 * AT MOST ONCE per probe: the `PROBE_RELOGIN_KEY` flag is set here and cleared on the next
 * callback, so a persistent `interaction_required` can never loop back into `prompt=none`.
 */
export async function restoreSessionSilently(): Promise<void> {
  window.sessionStorage.setItem(PROBE_RELOGIN_KEY, "1");
  await startLogin("/api-test", { prompt: "none" });
}

/**
 * Was the pending `/callback` the silent `prompt=none` session-restore? Reading this CLEARS the
 * flag (one-shot), so any `interaction_required` on this callback can trigger exactly one
 * interactive login and never re-enter the silent path (bounded: ≤ 1 `prompt=none` per probe).
 */
export function consumeSilentRestoreFlag(): boolean {
  const pending = window.sessionStorage.getItem(PROBE_RELOGIN_KEY) !== null;
  window.sessionStorage.removeItem(PROBE_RELOGIN_KEY);
  return pending;
}

/** Read + delete the one-shot wrong-`aud` probe result for display on `/api-test`. */
export function takeProbeResult(): ProbeResult | null {
  return takeProbeResultInner(window.sessionStorage);
}

/** The demo-resource endpoint to call with the current access token (`VITE_DEMO_API_URL`). */
export function demoApiUrl(): string {
  return env.VITE_DEMO_API_URL;
}

/** The `/userinfo` endpoint derived from the configured issuer. */
export function userinfoUrl(): string {
  return `${env.VITE_OIDC_ISSUER.replace(/\/+$/, "")}/userinfo`;
}

/* ---- Dev-only security lab (run 25, T5). Reached only from `/lab` and the gated callback branch. */

/** A fresh `/authorize` URL from the ordinary `beginLogin` (the lab never builds its own). */
async function labAuthorizeUrl(
  extra: Pick<AuthorizeConfig, "purpose" | "labScenario">,
): Promise<string> {
  const { discovery } = await ready();
  const { url } = await beginLogin(
    discovery,
    {
      clientId: env.VITE_OIDC_CLIENT_ID,
      redirectUri: env.VITE_OIDC_REDIRECT_URI,
      scope: env.VITE_OIDC_SCOPE,
      resource: env.VITE_OIDC_RESOURCE,
      ...extra,
    },
    window.sessionStorage,
  );
  return url;
}

/** Start a lab `/authorize` scenario (Task 3b): one parameter altered, transient `purpose:"lab"`. */
export async function startLabScenario(id: string): Promise<void> {
  const scenario = findLabScenario(id);
  if (!scenario) throw new Error("Unknown lab scenario");
  const url = await labAuthorizeUrl({ purpose: "lab", labScenario: scenario.id });
  window.location.assign(buildScenarioUrl(url, scenario, env.VITE_OIDC_ISSUER));
}

/** Start the `state`-tamper check (Task 3c): a genuine login whose returned `state` is forged. */
export async function startStateTamper(): Promise<void> {
  const url = await labAuthorizeUrl({ purpose: "login" });
  window.location.assign(tamperState(url, window.sessionStorage));
}

/** `/callback` for a lab scenario: record the outcome one-shot, never exchange the code. */
export function finishLabCallback(params: URLSearchParams): LabResult | null {
  return recordLabCallback(params, env.VITE_OIDC_ISSUER, window.sessionStorage);
}

/** `/callback` for the `state`-tamper check: run the real `finishLogin`, PASS only on rejection. */
export function finishStateTamper(params: URLSearchParams): Promise<LabResult> {
  return checkStateTamper(params, finishLogin, window.sessionStorage);
}

/** Read + delete the one-shot lab result for display on `/lab`. */
export function takeLabResult(): LabResult | null {
  return takeLabResultInner(window.sessionStorage);
}

/**
 * Replay an OLD refresh token straight at `/token` (Task 2), bypassing the store. Throws
 * `TokenEndpointError` on a non-2xx; a (wrongly) accepted response is discarded.
 */
export async function replayRefreshToken(refreshToken: string): Promise<void> {
  const { discovery } = await ready();
  await postToken(
    discovery.token_endpoint,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: env.VITE_OIDC_CLIENT_ID },
    fetch,
  );
}
