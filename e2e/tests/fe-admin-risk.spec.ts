import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import {
  ADMIN_SEED_EMAIL,
  ADMIN_SEED_PASSWORD,
  BE_PORT,
  DEV_SEED_EMAIL,
  DEV_SEED_PASSWORD,
  FE_ADMIN_PORT,
  FE_ADMIN_URL,
} from "../config/env";

/**
 * fe-admin BFF risk matrix (run 42 tester): non-admin user => 403 page (real IdP + real fe-admin),
 * real callback replay, returnTo kept through the login, and step-up that signs in as ANOTHER user
 * through the real IdP UI (DEBT-117) => both sessions gone. Assertions are booleans/counts only:
 * no token, code or state is ever printed.
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
  await signIn(page, DEV_SEED_EMAIL, DEV_SEED_PASSWORD, denied);
  const landed = new URL(page.url());
  expect(`${landed.origin}${landed.pathname}${landed.search}`).toBe(`${FE_ADMIN_URL}/users?tab=1`);
  await expect(page.getByTestId("viewer-email")).toHaveText(DEV_SEED_EMAIL);
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
  await signIn(page, DEV_SEED_EMAIL, DEV_SEED_PASSWORD, ended);
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
