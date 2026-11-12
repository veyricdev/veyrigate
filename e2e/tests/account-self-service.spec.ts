import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { test, expect, request, type Browser, type Page } from "@playwright/test";
import { BE_PORT, E2E_REDIS_URL, FE_PORT, ISSUER } from "../config/env";

/**
 * Account self-service (run 88 T4, C-7.5.2 / C-10.7b, D88.15–D88.22) on the real IdP UI. Each test
 * owns a DEDICATED user created through the real `/register` form + verification mail (Mailpit API),
 * so no seeded account, session or consent is touched.
 *
 *  1. `/account/sessions`: three browsers A/B/C (Chrome on Windows, Firefox on Linux, Safari on
 *     macOS). A sees the three sessions with allowlisted labels and no IP / raw UA / email; a POST
 *     without the form token is 403. A's session is then aged past the 5' re-authentication window
 *     (D88.18) by shifting `authTime` in the E2E Redis db (the only datastore write of this spec,
 *     own user only): the forms now ask for the current password; a wrong one changes nothing, the
 *     right one signs B out (B's next request lands on `/login`). Forgetting every other trusted
 *     device keeps C signed in (forgetting is not signing out); "Sign out every other session"
 *     signs C out and keeps A; finally A forgets its own device.
 *  2. Consent screen + `/account/apps`: the consent page names the client, the origin that receives
 *     the result, the OIDC scope descriptions and the lifetimes (the "days" sentence only with
 *     `offline_access`); after Allow, `/account/apps` lists the grant and `prompt=none` gets a code;
 *     revoking it makes `prompt=none` answer `consent_required` and a normal authorize shows the
 *     consent screen again.
 * URL waits use pathname/port predicates only (no full-URL regex: DEBT-108). The RP callback is
 * answered by a route stub, so fe-sso-test never exchanges the codes.
 */

const MAILPIT = "http://localhost:8025";
const isIdp = (url: URL) => url.port === String(BE_PORT);

const UA = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
};

interface Account {
  email: string;
  password: string;
}

/** Verification link of `to` from Mailpit (polled until the mail arrives). */
async function verificationLink(to: string): Promise<string> {
  const api = await request.newContext();
  try {
    let link = "";
    await expect
      .poll(
        async () => {
          const search = await api.get(`${MAILPIT}/api/v1/search`, { params: { query: `to:"${to}"` } });
          const found = ((await search.json()) as { messages?: { ID: string }[] }).messages ?? [];
          if (found.length === 0) return false;
          const msg = (await (await api.get(`${MAILPIT}/api/v1/message/${found[0].ID}`)).json()) as {
            Text?: string;
          };
          const m = /https?:\/\/\S+\/verify-email\S*/.exec(msg.Text ?? "");
          link = m ? m[0] : "";
          return link.length > 0;
        },
        { timeout: 30_000, message: "verification mail in Mailpit" },
      )
      .toBe(true);
    return link;
  } finally {
    await api.dispose();
  }
}

/** A fresh verified account through the real register form + verification mail. */
async function registerAccount(browser: Browser, tag: string): Promise<Account> {
  const account = { email: `e2e-${tag}-${randomUUID()}@example.com`, password: `E2e-${tag}#${randomUUID()}` };
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${ISSUER}/register`);
  const reg = page.locator('form[action="/register"]');
  await reg.getByLabel("Email").fill(account.email);
  await reg.getByLabel("Password").fill(account.password);
  await reg.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("a verification email has been sent")).toBeVisible();
  await page.goto(await verificationLink(account.email));
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await context.close();
  return account;
}

async function signedIn(browser: Browser, account: Account, userAgent: string): Promise<Page> {
  const page = await (await browser.newContext({ userAgent })).newPage();
  await page.goto(`${ISSUER}/login`);
  const form = page.locator('form[action="/login"]');
  await form.getByLabel("Email").fill(account.email);
  await form.getByLabel("Password").fill(account.password);
  await form.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/");
  await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
  return page;
}

/** Whether `page`'s IdP session is alive: `/` stays on the home page, or lands on `/login`. */
async function isSignedIn(page: Page): Promise<boolean> {
  await page.goto(`${ISSUER}/`);
  await page.waitForURL((url) => isIdp(url) && (url.pathname === "/" || url.pathname === "/login"));
  return new URL(page.url()).pathname === "/";
}

/**
 * Shift `authTime` of session `ref` back by `ms` in the E2E Redis db (TTL kept). Minimal RESP over
 * `node:net` (SELECT + EVAL); the Lua edits the number in place, so the stored JSON is otherwise
 * byte-identical. Returns the EVAL reply (1 = edited).
 */
async function ageSessionAuthTime(ref: string, ms: number): Promise<number> {
  const url = new URL(E2E_REDIS_URL);
  const db = url.pathname.slice(1) || "0";
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  const lua = [
    "local v = redis.call('GET', KEYS[1])",
    "if not v then return 0 end",
    "local n, c = string.gsub(v, '\"authTime\":(%d+)', function(t) return '\"authTime\":' .. string.format('%.0f', tonumber(t) - tonumber(ARGV[1])) end)",
    "if c ~= 1 then return -1 end",
    "redis.call('SET', KEYS[1], n, 'KEEPTTL')",
    "return 1",
  ].join("\n");
  const cmd = (parts: string[]) =>
    `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("")}`;
  return new Promise<number>((resolve, reject) => {
    const sock = connect(Number(url.port || 6379), host);
    let buf = "";
    sock.setTimeout(5_000, () => sock.destroy(new Error("redis timeout")));
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\r\n");
      if (lines.length < 3) return;
      sock.end();
      if (lines[0] !== "+OK" || !lines[1].startsWith(":")) reject(new Error(`unexpected redis reply: ${lines[0]} ${lines[1]}`));
      else resolve(Number(lines[1].slice(1)));
    });
    sock.write(cmd(["SELECT", db]) + cmd(["EVAL", lua, "1", `sess:${ref}`, String(ms)]));
  });
}

function authorizeUrl(scope: string, prompt?: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "fe-sso-test",
    redirect_uri: `http://localhost:${FE_PORT}/callback`,
    scope,
    resource: `${ISSUER}/demo/`,
    state: `s-${randomUUID()}`,
    nonce: `n-${randomUUID()}`,
    // S256 of a throwaway verifier; the codes are never exchanged (the callback is stubbed).
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  });
  if (prompt) params.set("prompt", prompt);
  return `${ISSUER}/authorize?${params.toString()}`;
}

const isCallback = (url: URL) => url.port === String(FE_PORT) && url.pathname === "/callback";

/** Navigate to `/authorize?…` and return the RP callback URL it ends on. */
async function callbackOf(page: Page, url: string, approve = false): Promise<URL> {
  const callback = page.waitForRequest((req) => isCallback(new URL(req.url())));
  await page.goto(url);
  if (approve) await page.getByRole("button", { name: "Allow" }).click();
  return new URL((await callback).url());
}

test("account sessions: list with labels, CSRF, re-authentication, revoke one / others, forget devices", async ({
  browser,
}) => {
  const account = await registerAccount(browser, "acs");

  // Anonymous: the page needs a session.
  const anon = await request.newContext();
  const anonRes = await anon.get(`${ISSUER}/account/sessions`, { maxRedirects: 0 });
  expect(anonRes.status()).toBe(302);
  expect(anonRes.headers()["location"]).toBe("/login?returnTo=%2Faccount%2Fsessions");
  await anon.dispose();

  const a = await signedIn(browser, account, UA.chromeWindows);
  const b = await signedIn(browser, account, UA.firefoxLinux);
  const c = await signedIn(browser, account, UA.safariMac);

  // A opens the page from the home link.
  const opened = a.waitForResponse((res) => {
    const url = new URL(res.url());
    return isIdp(url) && url.pathname === "/account/sessions" && res.request().method() === "GET";
  });
  await a.getByRole("link", { name: "Your sessions" }).click();
  await a.waitForURL((url) => isIdp(url) && url.pathname === "/account/sessions");
  const page = await opened;
  expect(page.headers()["cache-control"]).toBe("no-store");
  await expect(a.getByRole("heading", { name: "Your sessions" })).toBeVisible();

  const sessions = a.locator('h2:has-text("Signed-in sessions") + ul > li');
  const devices = a.locator('h2:has-text("Trusted devices") + p + ul > li');
  await expect(sessions).toHaveCount(3);
  await expect(sessions.filter({ hasText: "Chrome on Windows" })).toContainText("This browser");
  await expect(sessions.filter({ hasText: "Firefox on Linux" })).toHaveCount(1);
  await expect(sessions.filter({ hasText: "Safari on macOS" })).toHaveCount(1);
  await expect(sessions.filter({ hasText: "This browser" })).toHaveCount(1);
  await expect(sessions.first()).toContainText("Password");
  await expect(devices).toHaveCount(3);
  await expect(devices.filter({ hasText: "This browser" })).toHaveCount(1);
  // Exposure (D88.16): no email, raw UA or loopback IP anywhere in the HTML.
  const html = await a.content();
  for (const leak of [account.email, "Mozilla/5.0", "Gecko/", "127.0.0.1", "::1"]) {
    expect(html.includes(leak), `page HTML contains ${leak}`).toBe(false);
  }
  // Fresh session (< 5'): no password field yet.
  await expect(a.getByLabel("Current password")).toHaveCount(0);

  // CSRF: the session cookie without the form token => 403, nothing changed.
  const bRef = await sessions.filter({ hasText: "Firefox on Linux" }).locator('input[name="ref"]').inputValue();
  expect(bRef).toMatch(/^[0-9a-f]{64}$/);
  const forged = await a.request.post(`${ISSUER}/account/sessions/revoke`, { form: { ref: bRef }, maxRedirects: 0 });
  expect(forged.status()).toBe(403);
  expect(await isSignedIn(b)).toBe(true);

  // A's own ref (A's page never shows it in a form): read it from B's page, then age A's session.
  await b.goto(`${ISSUER}/account/sessions`);
  const aRef = await b
    .locator('h2:has-text("Signed-in sessions") + ul > li', { hasText: "Chrome on Windows" })
    .locator('input[name="ref"]')
    .inputValue();
  expect(await ageSessionAuthTime(aRef, 600_000)).toBe(1);

  await a.goto(`${ISSUER}/account/sessions`);
  await expect(a.getByText("Enter your current password to sign out a session or forget a device.")).toBeVisible();
  const bRow = sessions.filter({ hasText: "Firefox on Linux" });

  // Stale + wrong password: 400, B untouched.
  const wrong = a.waitForResponse((res) => {
    const url = new URL(res.url());
    return isIdp(url) && url.pathname === "/account/sessions/revoke" && res.request().method() === "POST";
  });
  await bRow.getByLabel("Current password").fill(`${account.password}-wrong`);
  await bRow.getByRole("button", { name: "Sign out this session" }).click();
  expect((await wrong).status()).toBe(400);
  await expect(a.getByRole("alert")).toHaveText("The current password is incorrect.");
  expect(await isSignedIn(b)).toBe(true);

  // Stale + right password: B is signed out, A and C stay.
  await a.goto(`${ISSUER}/account/sessions`);
  await bRow.getByLabel("Current password").fill(account.password);
  await bRow.getByRole("button", { name: "Sign out this session" }).click();
  await expect(a.getByRole("status")).toHaveText("The session was signed out.");
  await expect(sessions).toHaveCount(2);
  await expect(sessions.filter({ hasText: "Firefox on Linux" })).toHaveCount(0);
  expect(await isSignedIn(b)).toBe(false);
  expect(await isSignedIn(c)).toBe(true);

  // Forget every other trusted device: only this browser stays trusted; C is NOT signed out.
  await a.goto(`${ISSUER}/account/sessions`);
  await expect(devices).toHaveCount(3);
  const forgetOthers = a.locator('form[action="/account/devices/forget-others"]');
  await forgetOthers.getByLabel("Current password").fill(account.password);
  await forgetOthers.getByRole("button", { name: "Forget every other device" }).click();
  await expect(a.getByRole("status")).toHaveText("Every other device is no longer trusted.");
  await expect(devices).toHaveCount(1);
  await expect(devices.first()).toContainText("This browser");
  expect(await isSignedIn(c)).toBe(true);

  // Sign out every other session: C is signed out, A stays.
  await a.goto(`${ISSUER}/account/sessions`);
  const revokeOthers = a.locator('form[action="/account/sessions/revoke-others"]');
  await revokeOthers.getByLabel("Current password").fill(account.password);
  await revokeOthers.getByRole("button", { name: "Sign out every other session" }).click();
  await expect(a.getByRole("status")).toHaveText("Every other session was signed out.");
  await expect(sessions).toHaveCount(1);
  await expect(sessions.first()).toContainText("This browser");
  expect(await isSignedIn(c)).toBe(false);

  // Forget this device (A stays signed in).
  await a.goto(`${ISSUER}/account/sessions`);
  await devices.first().getByLabel("Current password").fill(account.password);
  await devices.first().getByRole("button", { name: "Forget this device" }).click();
  await expect(a.getByRole("status")).toHaveText("The device is no longer trusted.");
  await expect(devices).toHaveCount(0);
  expect(await isSignedIn(a)).toBe(true);

  for (const p of [a, b, c]) await p.context().close();
});

test("consent screen shows origin, scope descriptions and lifetimes; revoking in /account/apps asks again", async ({
  browser,
}) => {
  const account = await registerAccount(browser, "apps");
  const page = await signedIn(browser, account, UA.chromeWindows);
  // The RP callback is stubbed: fe-sso-test must never try to exchange these codes.
  await page.route(
    (url) => isCallback(url),
    (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>callback stub</p>" }),
  );

  // Without offline_access: lifetime of an access only, no "days" sentence.
  await page.goto(authorizeUrl("openid profile"));
  await expect(page.getByRole("heading", { name: "Authorize access" })).toBeVisible();
  await expect(page.getByText("Each access lasts up to 2 minutes.", { exact: true })).toBeVisible();
  await expect(page.getByText("days without you signing in again")).toHaveCount(0);

  // With offline_access (fe-sso-test has the refresh_token grant).
  await page.goto(authorizeUrl("openid profile email offline_access"));
  await expect(page.getByRole("heading", { name: "Authorize access" })).toBeVisible();
  await expect(page.locator("strong", { hasText: "fe-sso-test" })).toBeVisible();
  await expect(page.getByText(`It will receive the result at http://localhost:${FE_PORT}.`)).toBeVisible();
  for (const [scope, description] of [
    ["openid", "Confirm your identity"],
    ["profile", "See your basic profile"],
    ["email", "See your email address"],
    ["offline_access", "Stay signed in when you are not using it"],
  ]) {
    await expect(page.getByRole("listitem").filter({ hasText: `${scope}: ${description}` })).toHaveCount(1);
  }
  await expect(
    page.getByText(
      "Each access lasts up to 2 minutes. The app can keep access for up to 30 days without you signing in again.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Connected apps" })).toHaveAttribute("href", "/account/apps");

  // Allow => code at the RP.
  const allowed = page.waitForRequest((req) => isCallback(new URL(req.url())));
  await page.getByRole("button", { name: "Allow" }).click();
  expect((await allowed).url().includes("code=")).toBe(true);

  // Consent on record: prompt=none returns a code.
  const silent1 = await callbackOf(page, authorizeUrl("openid profile email offline_access", "none"));
  expect(silent1.searchParams.get("error")).toBeNull();
  expect(silent1.searchParams.get("code")).not.toBeNull();

  // /account/apps lists it.
  await page.goto(`${ISSUER}/`);
  await page.getByRole("link", { name: "Connected apps" }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/account/apps");
  await expect(page.getByRole("heading", { name: "Connected apps" })).toBeVisible();
  const rows = page.locator("ul > li", { has: page.locator('form[action="/account/apps/revoke"]') });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("fe-sso-test");
  await expect(rows.first()).toContainText(`${ISSUER}/demo/`);
  await expect(rows.first()).toContainText("offline_access");

  // CSRF: no form token => 403, the consent stays.
  const consentId = await rows.first().locator('input[name="consent_id"]').inputValue();
  expect(consentId).toMatch(/^[0-9a-f]{24}$/);
  const forged = await page.request.post(`${ISSUER}/account/apps/revoke`, {
    form: { consent_id: consentId },
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);

  // Revoke.
  await rows.first().getByRole("button", { name: "Revoke access" }).click();
  await expect(page.getByRole("status")).toHaveText("Access was revoked.");
  await expect(page.getByText("No app has access to your account.")).toBeVisible();
  await expect(rows).toHaveCount(0);

  // The next authorize asks again: prompt=none => consent_required, normal => the consent screen.
  const silent2 = await callbackOf(page, authorizeUrl("openid profile email offline_access", "none"));
  expect(silent2.searchParams.get("code")).toBeNull();
  expect(silent2.searchParams.get("error")).toBe("consent_required");
  await page.goto(authorizeUrl("openid profile email offline_access"));
  await expect(page.getByRole("heading", { name: "Authorize access" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();

  await page.context().close();
});
