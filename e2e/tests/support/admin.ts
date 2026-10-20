import { createHash, randomBytes } from "node:crypto";
import { expect, request, type BrowserContext } from "@playwright/test";
import { ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, BE_PORT, E2E_FE_ADMIN_SECRET, ISSUER } from "../../config/env";

/**
 * Admin token through the REAL `fe-admin` OAuth flow (run 39 Q-39.1): authorization_code + PKCE
 * S256 + `resource=<issuer>/admin/`; the 302 to `localhost:3000` (no fe-admin app in E2E) is read
 * from the response `Location` to get the `code`, then `/token` is called from Node with
 * `client_secret_basic`. Nothing is minted or written to a datastore. No URL / token is logged.
 */

const FE_ADMIN = "fe-admin";
const FE_ADMIN_REDIRECT = "http://localhost:3000/auth/callback";
const ADMIN_RESOURCE = `${ISSUER}/admin/`;
const b64url = (b: Buffer) => b.toString("base64url");
const basicAuth = `Basic ${Buffer.from(`${FE_ADMIN}:${E2E_FE_ADMIN_SECRET}`).toString("base64")}`;

export interface AdminTokens {
  accessToken: string;
  refreshToken: string;
  /** The IdP login form was shown during this authorization (proves `prompt=login` re-auth). */
  loginFormShown: boolean;
}

/** Sign the seeded super_admin in at the IdP as `fe-admin`; `forceLogin` ⇒ `prompt=login&max_age=0`. */
export async function adminToken(
  context: BrowserContext,
  { forceLogin = false }: { forceLogin?: boolean } = {},
): Promise<AdminTokens> {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: FE_ADMIN,
    redirect_uri: FE_ADMIN_REDIRECT,
    scope: "openid offline_access admin.read admin.write",
    resource: ADMIN_RESOURCE,
    state,
    nonce: b64url(randomBytes(16)),
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  if (forceLogin) {
    params.set("prompt", "login");
    params.set("max_age", "0");
  }

  // The IdP answers with a 302 to `localhost:3000` (no fe-admin app in E2E); the `code` is read
  // from that 302's Location. Playwright route handlers never see redirect hops (measured: a
  // `context.route` abort on :3000 still let the hop reach a listener there), so the hop is failed
  // at the Chromium network layer instead: the `code` never leaves the browser (DEBT-247).
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  cdp.on("Fetch.requestPaused", ({ requestId }: { requestId: string }) => {
    cdp.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => undefined);
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:3000/*", requestStage: "Request" }] });
  let callback: URL | null = null;
  let onCallback: () => void = () => undefined;
  const reached = new Promise<void>((r) => (onCallback = r));
  page.on("response", (res) => {
    const location = res.headers()["location"];
    if (res.status() >= 300 && res.status() < 400 && location?.startsWith(FE_ADMIN_REDIRECT)) {
      callback = new URL(location);
      onCallback();
    }
  });
  const step = (navigation: Promise<unknown>) =>
    Promise.race([reached, navigation.catch((err: unknown) => (callback ? undefined : Promise.reject(err)))]);

  let loginFormShown = false;
  try {
    await step(page.goto(`${ISSUER}/authorize?${params.toString()}`));
    for (let i = 0; i < 4 && !callback; i++) {
      const url = new URL(page.url());
      const onIdp = url.port === String(BE_PORT);
      const leftIdpPage = (u: URL) => u.port !== String(BE_PORT) || u.pathname !== url.pathname;
      if (onIdp && url.pathname === "/login") {
        loginFormShown = true;
        const form = page.locator('form[action="/login"]');
        await form.getByLabel("Email").fill(ADMIN_SEED_EMAIL);
        await form.getByLabel("Password").fill(ADMIN_SEED_PASSWORD);
        await step(
          Promise.all([
            page.waitForURL(leftIdpPage, { waitUntil: "load" }),
            form.getByRole("button", { name: "Sign in" }).click(),
          ]),
        );
      } else if (onIdp && url.pathname === "/authorize") {
        const consent = page.locator('form[action="/authorize/consent"]');
        await step(
          Promise.all([
            page.waitForURL(leftIdpPage, { waitUntil: "load" }),
            consent.getByRole("button", { name: "Allow" }).click(),
          ]),
        );
      } else {
        break;
      }
    }
  } finally {
    await page.close();
  }

  const cb = callback as URL | null;
  expect(cb !== null, "fe-admin authorization reached the redirect").toBe(true);
  expect(cb!.searchParams.get("state") === state, "state round-trip").toBe(true);
  expect(cb!.searchParams.get("iss") === ISSUER, "iss round-trip").toBe(true);
  const code = cb!.searchParams.get("code");
  expect(typeof code === "string" && code.length > 0, "authorization code issued").toBe(true);

  const res = await tokenRequest({
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: FE_ADMIN_REDIRECT,
    code_verifier: verifier,
  });
  expect(res.status, "fe-admin code exchange").toBe(200);
  const { access_token: at, refresh_token: rt } = res.body;
  // typeof, not String(): a missing token must fail here, not become "undefined" (DEBT-246).
  expect(typeof at === "string" && at.length > 0 && typeof rt === "string" && rt.length > 0, "tokens issued").toBe(
    true,
  );
  return { accessToken: at as string, refreshToken: rt as string, loginFormShown };
}

/** Refresh grant for `fe-admin`: the new access token carries no `auth_time` (StepUpGuard ⇒ 403). */
export async function adminRefresh(refreshToken: string): Promise<{ status: number; accessToken: string }> {
  const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  return { status: res.status, accessToken: String(res.body.access_token ?? "") };
}

async function tokenRequest(form: Record<string, string>) {
  const api = await request.newContext();
  try {
    const res = await api.post(`${ISSUER}/token`, { form, headers: { Authorization: basicAuth } });
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
  } finally {
    await api.dispose();
  }
}

/** Call the admin API (`/admin/...`) with a Bearer token; returns status + parsed JSON body. */
export async function adminApi(
  accessToken: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  data?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const api = await request.newContext();
  try {
    const res = await api.fetch(`${ISSUER}/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
      data,
    });
    const text = await res.text();
    return { status: res.status(), body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  } finally {
    await api.dispose();
  }
}

/** Clients of the admin's tenant whose `redirectUris` include `redirectUri` (all pages). */
export async function countClientsWithRedirect(accessToken: string, redirectUri: string): Promise<number> {
  let count = 0;
  let after: string | null = null;
  do {
    const query: string = `?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const page = await adminApi(accessToken, "GET", `/clients${query}`);
    expect(page.status, "list clients").toBe(200);
    const items = page.body.items as { redirectUris: string[] }[];
    count += items.filter((c) => c.redirectUris.includes(redirectUri)).length;
    after = page.body.nextCursor as string | null;
  } while (after);
  return count;
}
