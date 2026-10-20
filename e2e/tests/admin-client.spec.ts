import { test, expect, type Page } from "@playwright/test";
import { BE_PORT, DEV_SEED_EMAIL, DEV_SEED_PASSWORD } from "../config/env";
import { adminApi, adminRefresh, adminToken, countClientsWithRedirect } from "./support/admin";
import { captureTokenSecrets, expectNoSecretsExposed } from "./support/oidc";
import { freePort, startRp, type RpServer } from "./support/rp-server";

/**
 * Admin → new client → fe-sso-test uses it (run 39 Task 2, X2). Serial: (a) step-up refuses a
 * refresh-grant admin token, a `prompt=login&max_age=0` token creates a public client;
 * (b) a second fe-sso-test dev server runs as that client on a port picked at run time;
 * (c) consent Deny ⇒ `access_denied` and asked again, Allow ⇒ not asked again;
 * (d) `redirect_uris` changed ⇒ the IdP shows its own 400 page and never redirects back.
 * The client is created fresh every run (server-generated id) and disabled in `afterAll`.
 */

/** JWT payload, decoded without verification (assertions on claim presence only). */
const jwtPayload = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;

test.describe.serial("admin-created client", () => {
  let port = 0;
  let origin = "";
  let clientId: string | undefined;
  let rp: RpServer | undefined;

  const isIdp = (u: URL) => u.port === String(BE_PORT);
  const isRp = (u: URL) => u.port === String(port);

  test.beforeAll(async () => {
    port = await freePort();
    origin = `http://localhost:${port}`;
  });

  test.afterAll(async ({ browser }) => {
    await rp?.stop();
    if (!clientId) return;
    const ctx = await browser.newContext();
    try {
      const admin = await adminToken(ctx, { forceLogin: true });
      const res = await adminApi(admin.accessToken, "PATCH", `/clients/${clientId}`, { disabled: true });
      if (res.status !== 200) console.warn(`disable client ${clientId}: HTTP ${res.status}`);
    } catch {
      console.warn(`disable client ${clientId}: failed`);
    } finally {
      await ctx.close();
    }
  });

  test("step-up: refresh-grant admin token ⇒ 403 step_up_required; re-auth ⇒ client created", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const body = {
      clientType: "public",
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [`${origin}/callback`],
      postLogoutRedirectUris: [`${origin}/`],
      allowedCorsOrigins: [origin],
      allowedResources: ["demo"],
      scopes: ["openid", "profile", "email", "offline_access"],
    };

    const first = await adminToken(ctx);
    const refreshed = await adminRefresh(first.refreshToken);
    expect(refreshed.status).toBe(200);
    // Pin the premise (DEBT-248): the refresh-grant token carries no `auth_time`, the
    // interactive one does. Payload decoded without verification; booleans only, nothing echoed.
    expect("auth_time" in jwtPayload(first.accessToken), "interactive token has auth_time").toBe(true);
    expect("auth_time" in jwtPayload(refreshed.accessToken), "refresh-grant token has auth_time").toBe(false);
    const before = await countClientsWithRedirect(first.accessToken, `${origin}/callback`);

    const denied = await adminApi(refreshed.accessToken, "POST", "/clients", body);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("step_up_required");
    expect(denied.body.max_age).toBe(0);
    expect(await countClientsWithRedirect(first.accessToken, `${origin}/callback`)).toBe(before);

    // Same browser context (IdP session alive): prompt=login still shows the login form.
    const fresh = await adminToken(ctx, { forceLogin: true });
    expect(fresh.loginFormShown).toBe(true);
    expect("auth_time" in jwtPayload(fresh.accessToken), "re-auth token has auth_time").toBe(true);
    const created = await adminApi(fresh.accessToken, "POST", "/clients", body);
    expect(created.status).toBe(201);
    expect(typeof created.body.clientId).toBe("string");
    clientId = created.body.clientId as string;
    await ctx.close();

    rp = await startRp(clientId, port);
  });

  test("consent: Deny ⇒ access_denied and asked again; Allow ⇒ not asked again", async ({ browser }) => {
    expect(clientId, "client created by the previous step").toBeTruthy();
    const page = await (await browser.newContext()).newPage();
    const capture = captureTokenSecrets(page);
    let tokenPosts = 0;
    page.on("request", (req) => {
      const u = new URL(req.url());
      if (isIdp(u) && u.pathname === "/token" && req.method() === "POST") tokenPosts++;
    });
    const consentForm = page.locator('form[action="/authorize/consent"]');
    const claims = page.getByTestId("claims");

    await startSignIn(page);
    await page.waitForURL((u) => isIdp(u) && u.pathname === "/login", { waitUntil: "load" });
    const loginForm = page.locator('form[action="/login"]');
    await loginForm.getByLabel("Email").fill(DEV_SEED_EMAIL);
    await loginForm.getByLabel("Password").fill(DEV_SEED_PASSWORD);
    await loginForm.getByRole("button", { name: "Sign in" }).click();
    await expect(consentForm).toBeVisible();
    await consentForm.getByRole("button", { name: "Deny" }).click();
    await page.waitForURL((u) => isRp(u) && u.pathname === "/error");
    await expect(page.getByTestId("error-code")).toHaveText("access_denied");
    expect(tokenPosts).toBe(0);

    // Deny is not stored: the next sign-in (IdP session alive, no login form) asks again.
    await startSignIn(page);
    await expect(consentForm).toBeVisible();
    await consentForm.getByRole("button", { name: "Allow" }).click();
    await expect(claims).toBeVisible();
    await expect(page.getByTestId("claim-aud")).toHaveText(clientId!);

    // Allow is stored: a fresh sign-in never renders the consent page (`/authorize` 200).
    let authorizePages = 0;
    page.on("response", (res) => {
      const u = new URL(res.url());
      if (res.request().isNavigationRequest() && isIdp(u) && u.pathname === "/authorize" && res.status() === 200) {
        authorizePages++;
      }
    });
    await startSignIn(page);
    await expect(claims).toBeVisible();
    expect(authorizePages).toBe(0);

    const { secrets, unreadable } = await capture.collect();
    expect(unreadable).toBe(0);
    await expectNoSecretsExposed(page, secrets);
    await page.context().close();
  });

  test("redirect_uris changed ⇒ IdP 400 error page, nothing sent to the old callback", async ({
    browser,
  }) => {
    expect(clientId, "client created by the first step").toBeTruthy();
    const ctx = await browser.newContext();
    const admin = await adminToken(ctx, { forceLogin: true });
    const patched = await adminApi(admin.accessToken, "PATCH", `/clients/${clientId}`, {
      redirectUris: [`${origin}/elsewhere`],
    });
    expect(patched.status).toBe(200);
    await ctx.close();

    const page = await (await browser.newContext()).newPage();
    let callbackRequests = 0;
    page.on("request", (req) => {
      const u = new URL(req.url());
      if (isRp(u) && u.pathname === "/callback") callbackRequests++;
    });
    await page.goto(`${origin}/`);
    const [nav] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().isNavigationRequest() && new URL(res.url()).pathname === "/authorize",
      ),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    expect(nav.status()).toBe(400);
    await expect(page).toHaveURL((u) => isIdp(u) && u.pathname === "/authorize");
    await expect(page.getByRole("heading", { name: "Invalid request" })).toBeVisible();
    expect(callbackRequests).toBe(0);
    await page.context().close();
  });

  /** RP home (reload: tokens are in memory only, so the anonymous view) → "Sign in". */
  async function startSignIn(page: Page): Promise<void> {
    await page.goto(`${origin}/`);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
});
