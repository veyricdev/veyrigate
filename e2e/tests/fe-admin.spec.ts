import { test, expect, type Page } from "@playwright/test";
import { ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, BE_PORT, FE_ADMIN_PORT, FE_ADMIN_URL, ISSUER } from "../config/env";

/**
 * fe-admin BFF login (run 42 A4, Task 4). Real IdP + real fe-admin dev server: sign in as the E2E
 * admin, prove no token reaches the browser (cookie httpOnly, Web Storage, HTML, /_serverFn
 * responses), then RP-initiated logout ends the IdP session too. Checks are booleans / counts only:
 * nothing token-like is printed.
 */

const isIdp = (url: URL) => url.port === String(BE_PORT);
const isAdminApp = (url: URL) => url.port === String(FE_ADMIN_PORT);

/** On the IdP login page: sign the E2E admin in and approve consent until back on fe-admin. */
async function signInAsAdmin(page: Page): Promise<void> {
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
  const form = page.locator('form[action="/login"]');
  await form.getByLabel("Email").fill(ADMIN_SEED_EMAIL);
  await form.getByLabel("Password").fill(ADMIN_SEED_PASSWORD);
  await form.getByRole("button", { name: "Sign in" }).click();
  const consent = page.locator('form[action="/authorize/consent"]');
  const email = page.getByTestId("viewer-email");
  for (let i = 0; i < 3; i++) {
    await expect(consent.or(email).first()).toBeVisible({ timeout: 30_000 });
    if (await email.isVisible()) return;
    await consent.getByRole("button", { name: "Allow" }).click();
    await consent.waitFor({ state: "detached" });
  }
}

test("fe-admin: BFF login shows the admin, no token in the browser, logout ends the IdP session", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const appBodies: Promise<{ path: string; body: string }>[] = [];
  page.on("response", (res) => {
    const url = new URL(res.url());
    if (!isAdminApp(url) || res.status() >= 300) return;
    // Documents and server-function responses carry app data. (Vite dev modules are skipped: their
    // inline base64 source maps start with "eyJ" too.)
    const html = (res.headers()["content-type"] ?? "").includes("text/html");
    if (!html && !url.pathname.startsWith("/_serverFn")) return;
    appBodies.push(res.text().then((body) => ({ path: url.pathname, body }), () => ({ path: url.pathname, body: "" })));
  });

  // Not signed in: / sends the browser to the IdP login form through /auth/login.
  await page.goto(`${FE_ADMIN_URL}/`);
  await signInAsAdmin(page);
  await expect(page.getByTestId("viewer-email")).toHaveText(ADMIN_SEED_EMAIL);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // A client-side navigation (404 page -> "Back to dashboard") runs the guard through its server
  // function over /_serverFn.
  await page.goto(`${FE_ADMIN_URL}/does-not-exist`, { waitUntil: "networkidle" }); // hydrated
  const rpc = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return isAdminApp(url) && url.pathname.startsWith("/_serverFn");
  });
  await page.getByRole("link", { name: "Back to dashboard" }).click();
  expect((await rpc).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // DevTools-equivalent checks.
  const cookies = await context.cookies(FE_ADMIN_URL);
  const sid = cookies.find((c) => c.name === "fea_sid");
  expect(sid?.httpOnly, "fea_sid is httpOnly").toBe(true);
  expect(sid?.sameSite).toBe("Lax");
  expect(cookies.some((c) => c.name === "fea_tx"), "transaction cookie cleared").toBe(false);
  const jsView = await page.evaluate(() => ({
    cookie: document.cookie,
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
  }));
  expect(jsView.cookie.includes("fea_sid"), "session cookie invisible to JS").toBe(false);
  expect(jsView.local.includes("eyJ") || jsView.session.includes("eyJ"), "no JWT in Web Storage").toBe(false);
  expect(/token/i.test(jsView.local + jsView.session), "no token key in Web Storage").toBe(false);
  expect((await page.content()).includes("eyJ"), "no JWT in the live DOM").toBe(false);
  const html = await (await context.request.get(`${FE_ADMIN_URL}/`)).text();
  expect(html.includes(ADMIN_SEED_EMAIL), "SSR HTML is the signed-in page").toBe(true);
  expect(html.includes("eyJ"), "no JWT in the SSR HTML").toBe(false);
  const bodies = await Promise.all(appBodies);
  expect(bodies.some((b) => b.path.startsWith("/_serverFn")), "a /_serverFn response was observed").toBe(true);
  // JWT shape (base64url JSON header, then "."), not a bare "eyJ": an audit page's opaque
  // `nextCursor` is base64url(JSON) too and starts with "eyJ" (run 51 tester, dashboard events).
  const jwt = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\./; // JWS, and JWE with an empty key segment
  expect(bodies.filter((b) => jwt.test(b.body)).map((b) => b.path), "no JWT in any fe-admin document or /_serverFn response").toEqual([]);

  // RP-initiated logout: fe-admin POST -> IdP confirmation -> confirm -> back on fe-admin -> the
  // guard sends the browser to login again and the IdP shows its form (IdP session is gone).
  await page.getByRole("banner").getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/logout", { waitUntil: "load" });
  await page.locator('form[action="/logout"]').getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
  await expect(page.locator('form[action="/login"]')).toBeVisible();
  expect((await context.cookies(FE_ADMIN_URL)).some((c) => c.name === "fea_sid"), "session cookie removed").toBe(
    false,
  );

  // Coming back later: still the IdP login form, never a silent sign-in.
  await page.goto(`${FE_ADMIN_URL}/`);
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
  await expect(page.locator('form[action="/login"]')).toBeVisible();
  await context.close();
});

test("fe-admin: a forged callback (no transaction cookie) gets the generic error page, no session", async ({
  playwright,
}) => {
  const api = await playwright.request.newContext();
  try {
    const qs = new URLSearchParams({ code: "x", state: "y", iss: ISSUER });
    const res = await api.get(`${FE_ADMIN_URL}/auth/callback?${qs.toString()}`, { maxRedirects: 0 });
    expect(res.status()).toBe(400);
    const setCookie = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
    expect(setCookie.some((c) => c.startsWith("fea_sid=")), "no session cookie").toBe(false);
    const body = await res.text();
    expect(body).toContain("Sign-in failed");
    expect(body.includes("eyJ") || body.includes("<script"), "generic page only").toBe(false);
  } finally {
    await api.dispose();
  }
});
