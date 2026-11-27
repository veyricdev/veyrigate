import { randomBytes } from "node:crypto";
import { test, expect, type Page, type BrowserContext, type APIResponse, type Response } from "@playwright/test";
import {
  ADMIN_SEED_EMAIL,
  ADMIN_SEED_PASSWORD,
  BE_PORT,
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
  FE_ADMIN_PORT,
  FE_ADMIN_URL,
} from "../config/env";
import { passSecondFactorIfAsked } from "./support/fe-admin";

/**
 * fe-admin BFF risk matrix (run 42 tester): non-admin user => 403 page (real IdP + real fe-admin),
 * real callback replay, returnTo kept through the login, and step-up that signs in as ANOTHER user
 * through the real IdP UI (DEBT-117) => both sessions gone. Assertions are booleans/counts only:
 * no token, code or state is ever printed. Run 89 (D89.5): the `admin` resource needs a second
 * factor for EVERY user, so the non-admin is `E2E_USER` (enrolled, no role) instead of the dev user
 * (not enrolled => the IdP stops at "Two-step verification required", covered by `mfa.spec.ts`).
 */

const isIdp = (url: URL) => url.port === String(BE_PORT);
const isAdminApp = (url: URL) => url.port === String(FE_ADMIN_PORT);

/** On the IdP login form: sign in and approve consent until `done` shows up on fe-admin. */
async function signIn(page: Page, email: string, password: string, done: ReturnType<Page["locator"]>) {
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
  const form = page.locator('form[action="/login"]');
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in" }).click();
  const consent = page.locator('form[action="/authorize/consent"]');
  await passSecondFactorIfAsked(page, email, consent.or(done));
  for (let i = 0; i < 3; i++) {
    await expect(consent.or(done).first()).toBeVisible({ timeout: 30_000 });
    if (await done.isVisible()) return;
    await consent.getByRole("button", { name: "Allow" }).click();
    await consent.waitFor({ state: "detached" });
  }
  await expect(done).toBeVisible();
}

const sidOf = async (context: BrowserContext) =>
  (await context.cookies(FE_ADMIN_URL)).find((c) => c.name === "fea_sid");

test("fe-admin: a signed-in user without an admin role gets the 403 page; callback replay is rejected", async ({
  browser,
}) => {
  // Run 89: an IdP sign-in now includes TOTP, which may wait up to one 30 s step (replay rule, AC2).
  test.setTimeout(90_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  let callbackUrl: string | null = null;
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (isAdminApp(u) && u.pathname === "/auth/callback" && r.isNavigationRequest()) callbackUrl = r.url();
  });

  // Deep link with a query: kept through the whole login (returnTo stored server-side).
  await page.goto(`${FE_ADMIN_URL}/users?tab=1`);
  const denied = page.getByRole("heading", { name: "Access denied" });
  await signIn(page, E2E_USER_EMAIL, E2E_USER_PASSWORD, denied);
  const landed = new URL(page.url());
  expect(`${landed.origin}${landed.pathname}${landed.search}`).toBe(`${FE_ADMIN_URL}/users?tab=1`);
  await expect(page.getByTestId("viewer-email")).toHaveText(E2E_USER_EMAIL);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("button", { name: "Sign out" })).toBeVisible();

  // Same for the dashboard and for SSR: no admin content, no token.
  const res = await context.request.get(`${FE_ADMIN_URL}/`);
  const html = await res.text();
  expect(html.includes("Access denied"), "SSR renders the 403 page").toBe(true);
  expect(html.includes("eyJ"), "no JWT in the SSR HTML").toBe(false);
  const sid = await sidOf(context);
  expect(sid?.httpOnly).toBe(true);

  // Replaying the real callback URL (code + state) in the same browser => generic error, no new session.
  expect(callbackUrl, "callback observed").not.toBeNull();
  const replay = await context.request.get(callbackUrl!, { maxRedirects: 0 });
  expect(replay.status()).toBe(400);
  const replayCookies = replay.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie");
  expect(replayCookies.some((h) => h.value.startsWith("fea_sid=")), "no session cookie on replay").toBe(false);
  expect((await replay.text()).includes("Sign-in failed")).toBe(true);
  expect((await sidOf(context))?.value === sid?.value, "existing session untouched").toBe(true);

  // Sign out from the 403 page itself.
  await page.getByRole("main").getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/logout", { waitUntil: "load" });
  await page.locator('form[action="/logout"]').getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
  expect(await sidOf(context)).toBeUndefined();
  await context.close();
});

test("fe-admin: step-up that signs in as another user ends the session (DEBT-117, real IdP UI)", async ({
  browser,
  playwright,
}) => {
  // Run 89: an IdP sign-in now includes TOTP, which may wait up to one 30 s step (replay rule, AC2).
  test.setTimeout(90_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${FE_ADMIN_URL}/`);
  await signIn(page, ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, page.getByTestId("viewer-email"));
  await expect(page.getByTestId("viewer-email")).toHaveText(ADMIN_SEED_EMAIL);
  const adminSid = await sidOf(context);
  expect(adminSid).toBeDefined();

  // Step-up: prompt=login&max_age=0 => the IdP shows its login form even with a live IdP session.
  await page.goto(`${FE_ADMIN_URL}/auth/login?stepup=1&returnTo=%2F`);
  const ended = page.getByRole("alert");
  await signIn(page, E2E_USER_EMAIL, E2E_USER_PASSWORD, ended);
  await expect(ended).toContainText("ended for security reasons");
  const at = new URL(page.url());
  expect(isAdminApp(at) && at.pathname === "/auth/callback").toBe(true);
  expect(await sidOf(context), "session cookie cleared").toBeUndefined();

  // The old admin cookie is dead server-side too: the guard sends it to login and clears it.
  const api = await playwright.request.newContext();
  try {
    const stale = await api.get(`${FE_ADMIN_URL}/`, {
      headers: { cookie: `fea_sid=${adminSid!.value}` },
      maxRedirects: 0,
    });
    expect(stale.status()).toBeGreaterThanOrEqual(300);
    expect(stale.status()).toBeLessThan(400);
    expect(stale.headers()["location"]?.startsWith("/auth/login")).toBe(true);
    const html = await stale.text();
    expect(html.includes(ADMIN_SEED_EMAIL)).toBe(false);
  } finally {
    await api.dispose();
  }
  await context.close();
});

/**
 * Run 101 (D101.6): Start 1.169 made `getResponseHeaders()` a read-only copy; fe-admin now writes
 * Set-Cookie through `appendResponseHeader`. Unit tests mock that helper, so these two lock the real
 * runtime: a dead session cookie is cleared on the SSR answer and on the `/_serverFn` RPC answer.
 */
/** Set-Cookie values (`Response.headersArray()` is async, `APIResponse`'s is not). */
const setCookies = async (res: APIResponse | Response): Promise<string[]> =>
  (await res.headersArray()).filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);

function expectSidCleared(cookies: string[]) {
  const sid = cookies.filter((c) => c.startsWith("fea_sid="));
  expect(sid.length, "exactly one fea_sid Set-Cookie").toBe(1);
  const attrs = sid[0]!.split(";").map((a) => a.trim());
  expect(attrs[0], "fea_sid emptied").toBe("fea_sid=");
  expect(attrs).toContain("Max-Age=0");
  expect(attrs).toContain("HttpOnly");
  expect(attrs.some((a) => a.startsWith("SameSite=")), "SameSite set").toBe(true);
  expect(attrs).toContain("Path=/");
}

test("fe-admin: SSR with an unknown session cookie => 307 to login and the cookie cleared (D101.6)", async ({
  playwright,
}) => {
  const api = await playwright.request.newContext();
  try {
    const res = await api.get(`${FE_ADMIN_URL}/`, {
      headers: { cookie: `fea_sid=${randomBytes(32).toString("base64url")}` },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]?.startsWith("/auth/login?"), "redirect to login").toBe(true);
    const cookies = await setCookies(res);
    expect(cookies.length, "only the clearing Set-Cookie").toBe(1);
    expectSidCleared(cookies);
    expect(res.headers()["cache-control"] ?? "").toContain("no-store");
  } finally {
    await api.dispose();
  }
});

test("fe-admin: RPC getViewer with an unknown session cookie clears it and goes to login (D101.6)", async ({
  browser,
}) => {
  // An IdP sign-in includes TOTP, which may wait up to one 30 s step (replay rule, AC2).
  test.setTimeout(90_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${FE_ADMIN_URL}/`);
    await signIn(page, ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, page.getByTestId("viewer-email"));
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    // Hydrated (dev server: every module loaded), else the click is a document load answered by SSR.
    await page.waitForLoadState("networkidle");
    const forged = randomBytes(32).toString("base64url");
    // Clear first: an added cookie may not share the real one's identity (host-only flag) => two cookies.
    await context.clearCookies({ name: "fea_sid" });
    await context.addCookies([{ name: "fea_sid", value: forged, url: FE_ADMIN_URL, httpOnly: true, sameSite: "Lax" }]);
    const sids = (await context.cookies(FE_ADMIN_URL)).filter((c) => c.name === "fea_sid");
    expect(sids.length === 1 && sids[0]!.value === forged, "cookie replaced").toBe(true);

    // Client-side navigation: the root guard calls getViewer through `/_serverFn` (no document load).
    const rpc = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname.startsWith("/_serverFn/"));
    // The IdP session is still live: answer the login route here, or it would sign straight back in.
    let toLogin = 0;
    await page.route(
      (url) => isAdminApp(url) && url.pathname === "/auth/login",
      (route) => {
        if (route.request().isNavigationRequest()) toLogin += 1;
        return route.fulfill({ status: 200, contentType: "text/plain", body: "login" });
      },
    );
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Users" }).click();
    const res = await rpc;
    expect(res.request().isNavigationRequest(), "an RPC, not a document").toBe(false);
    expectSidCleared(await setCookies(res));
    await expect.poll(() => toLogin, { message: "the UI goes back to login (reloadDocument)" }).toBe(1);
    expect(await sidOf(context), "cookie gone from the browser").toBeUndefined();
  } finally {
    await context.close();
  }
});
