import { randomUUID } from "node:crypto";
import { test, expect, request, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { BE_PORT, E2E_MFA_USER_EMAIL, E2E_MFA_USER_PASSWORD, FE_ADMIN_PORT, FE_ADMIN_URL, ISSUER } from "../config/env";
import { mfaForm, passSecondFactor, signInAsAdmin } from "./support/fe-admin";
import { approveConsentUntil } from "./support/oidc";
import { nextCode, rememberSecret, stepAt, totpAt } from "./support/totp";

/**
 * Run 89 T6 AC5: two-step verification (TOTP + recovery codes) on the real IdP UI and fe-admin.
 * Codes come from the independent `support/totp.ts` (never from `be/`). Users:
 *  - a fresh account per run through the real `/register` + Mailpit verification (enroll, step 2,
 *    wrong codes, replay, recovery codes, turn off): its wrong codes never pile up across runs in
 *    the per-user attempt bucket (10 / 15 min);
 *  - `E2E_MFA_USER` (seeded WITHOUT MFA every run, no role): the admin console forces it to enroll,
 *    then an admin resets it from fe-admin and it enrolls again;
 *  - a fresh Google (mock) account per run: federation never skips step 2.
 * The 50-failure cap (D89.25) is left to int (`run89-mfa-cap.int-spec.ts`): 50 wrong codes exceed
 * the 10 / 15 min attempt bucket by design. URL waits use pathname/port predicates; no code, seed
 * or URL is printed.
 */

const MAILPIT = "http://localhost:8025";
const isIdp = (url: URL) => url.port === String(BE_PORT);
const isAdminApp = (url: URL) => url.port === String(FE_ADMIN_PORT);
const WRONG = "That code is not valid. Try again.";

interface Account {
  email: string;
  password: string;
}

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
          const msg = (await (await api.get(`${MAILPIT}/api/v1/message/${found[0].ID}`)).json()) as { Text?: string };
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

async function registerAccount(browser: Browser): Promise<Account> {
  const account = { email: `e2e-mfa-${randomUUID()}@example.com`, password: `E2e-mfa#${randomUUID()}` };
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${ISSUER}/register`);
  const reg = page.locator('form[action="/register"]');
  await reg.getByLabel("Email").fill(account.email);
  await reg.getByLabel("Password").fill(account.password);
  await reg.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("a verification email has been sent")).toBeVisible();
  await page.goto(await verificationLink(account.email));
  // Run 91 (DEBT-671, D91.14): verifying the email also proves the password.
  await page.getByLabel("Password of the account").fill(account.password);
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await context.close();
  return account;
}

/** Password step at the IdP (`returnTo` default `/`), in a fresh context unless `page` is given. */
async function passwordStep(page: Page, account: Account, returnTo = "/"): Promise<void> {
  await page.goto(`${ISSUER}/login?returnTo=${encodeURIComponent(returnTo)}`);
  const form = page.locator('form[action="/login"]');
  await form.getByLabel("Email").fill(account.email);
  await form.getByLabel("Password").fill(account.password);
  await form.getByRole("button", { name: "Sign in" }).click();
}

/** Submit `code` on `/login/mfa`; the POST status (302 = accepted, 400 = refused). */
async function submitCode(page: Page, code: string): Promise<number> {
  const form = mfaForm(page);
  await form.getByLabel("Code").fill(code);
  const [res] = await Promise.all([
    page.waitForResponse((r) => isIdp(new URL(r.url())) && new URL(r.url()).pathname === "/login/mfa" && r.request().method() === "POST"),
    form.getByRole("button", { name: "Verify" }).click(),
  ]);
  await page.waitForLoadState("load");
  return res.status();
}

const onStep2 = (page: Page) => page.waitForURL((u) => isIdp(u) && u.pathname === "/login/mfa", { waitUntil: "load" });
const onHome = async (page: Page) => {
  await page.waitForURL((u) => isIdp(u) && u.pathname === "/", { waitUntil: "load" });
  await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
};

/** No IdP session in `context` (step 1 alone never creates one): `/account/mfa` sends to `/login`. */
async function expectNoSession(context: BrowserContext): Promise<void> {
  const res = await context.request.get(`${ISSUER}/account/mfa`, { maxRedirects: 0 });
  expect(res.status(), "no session before step 2").toBe(302);
  expect(res.headers()["location"]?.startsWith("/login"), "redirect to the password step").toBe(true);
}

/** On `/account/mfa` (signed in, fresh): set up, read the key from the page, confirm; the 10 codes. */
async function enroll(page: Page, email: string): Promise<{ secret: string; codes: string[] }> {
  await page.getByRole("button", { name: "Set up two-step verification" }).click();
  await expect(page.getByRole("heading", { name: "Set up two-step verification" })).toBeVisible();
  const secret = ((await page.locator("p", { hasText: "Setup key:" }).locator("code").textContent()) ?? "").replace(/\s+/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  const otpauth = await page.getByRole("link", { name: "Open in an authenticator app" }).getAttribute("href");
  expect(otpauth?.startsWith("otpauth://totp/Veyrigate%3A"), "otpauth link, no QR").toBe(true);
  expect(otpauth?.includes(`secret=${secret}`)).toBe(true);
  const form = page.locator('form[action="/account/mfa/confirm"]');
  await form.getByLabel("Code").fill(await nextCode(secret));
  await form.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("heading", { name: "Two-step verification is on" })).toBeVisible();
  const codes = (await page.locator("li code").allTextContents()).map((c) => c.trim());
  expect(codes).toHaveLength(10);
  expect(new Set(codes).size).toBe(10);
  rememberSecret(email, secret);
  return { secret, codes };
}

/** A 6-digit code the IdP cannot accept now (none of steps c-1..c+1). */
function wrongCode(secret: string): string {
  const c = stepAt(Date.now());
  const valid = new Set([-2, -1, 0, 1, 2].map((d) => totpAt(secret, c + d)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, "0");
    if (!valid.has(code)) return code;
  }
}

async function fresh(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test("mfa: enroll (key, no QR) => 10 codes once + signed out; step 2 required; 5 wrong => password again; replay refused; recovery code once; turn off with TOTP and with a recovery code", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const account = await registerAccount(browser);

  // (a) enroll on /account/mfa (fresh session => no password asked).
  const a = await fresh(browser);
  await passwordStep(a.page, account, "/account/mfa");
  await a.page.waitForURL((u) => isIdp(u) && u.pathname === "/account/mfa", { waitUntil: "load" });
  const { secret, codes } = await enroll(a.page, account.email);
  expect(codes.every((c) => /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(c)), "recovery code shape").toBe(true);
  // Every session (this one too) ended.
  await expectNoSession(a.context);
  await a.context.close();

  // (b) step 2 required; no session after the password; 5 wrong codes => back to the password step.
  const b = await fresh(browser);
  await passwordStep(b.page, account);
  await onStep2(b.page);
  await expectNoSession(b.context);
  for (let i = 0; i < 5; i++) {
    const status = await submitCode(b.page, wrongCode(secret));
    if (i < 4) {
      expect(status, `wrong code ${i + 1}`).toBe(400);
      await expect(b.page.getByRole("alert")).toHaveText(WRONG);
    } else {
      expect(status, "5th wrong code restarts sign-in").toBe(302);
    }
  }
  await b.page.waitForURL((u) => isIdp(u) && u.pathname === "/login", { waitUntil: "load" });
  await expect(b.page.locator('form[action="/login"]')).toBeVisible();
  await expectNoSession(b.context);
  // Right password + right code => signed in; codes are not shown again on /account/mfa.
  await passwordStep(b.page, account, "/account/mfa");
  await onStep2(b.page);
  const used = await nextCode(secret);
  expect(await submitCode(b.page, used)).toBe(302);
  await b.page.waitForURL((u) => isIdp(u) && u.pathname === "/account/mfa", { waitUntil: "load" });
  await expect(b.page.getByText("Recovery codes left: 10.")).toBeVisible();
  await expect(b.page.locator("li code")).toHaveCount(0);
  await b.context.close();

  // (c) the same code again (same step) => refused; a fresh step => accepted.
  const c = await fresh(browser);
  await passwordStep(c.page, account);
  await onStep2(c.page);
  expect(await submitCode(c.page, used), "replayed TOTP step").toBe(400);
  await expect(c.page.getByRole("alert")).toHaveText(WRONG);
  expect(await submitCode(c.page, await nextCode(secret))).toBe(302);
  await onHome(c.page);
  await c.context.close();

  // (d) a recovery code signs in once; the second use is refused.
  const d1 = await fresh(browser);
  await passwordStep(d1.page, account);
  await onStep2(d1.page);
  expect(await submitCode(d1.page, codes[0]!)).toBe(302);
  await onHome(d1.page);
  await d1.context.close();
  const d2 = await fresh(browser);
  await passwordStep(d2.page, account, "/account/mfa");
  await onStep2(d2.page);
  expect(await submitCode(d2.page, codes[0]!), "used recovery code").toBe(400);
  await expect(d2.page.getByRole("alert")).toHaveText(WRONG);
  expect(await submitCode(d2.page, await nextCode(secret))).toBe(302);
  await d2.page.waitForURL((u) => isIdp(u) && u.pathname === "/account/mfa", { waitUntil: "load" });
  await expect(d2.page.getByText("Recovery codes left: 9.")).toBeVisible();

  // Turn off: password + authenticator code => off, signed out; the next sign-in has no step 2.
  const off = d2.page.locator('form[action="/account/mfa/disable"]');
  await off.getByLabel("Current password").fill(account.password);
  await off.getByLabel("Authenticator code or recovery code").fill(await nextCode(secret));
  await off.getByRole("button", { name: "Turn off two-step verification" }).click();
  await expect(d2.page.getByRole("heading", { name: "Two-step verification is off" })).toBeVisible();
  await expectNoSession(d2.context);
  await passwordStep(d2.page, account, "/account/mfa");
  await d2.page.waitForURL((u) => isIdp(u) && u.pathname === "/account/mfa", { waitUntil: "load" });
  await expect(d2.page.getByText("Two-step verification is off.")).toBeVisible();

  // Enroll again (new key), then turn off with password + a RECOVERY code (lost device, D89.27).
  const second = await enroll(d2.page, account.email);
  expect(second.secret).not.toBe(secret);
  await passwordStep(d2.page, account, "/account/mfa");
  await onStep2(d2.page);
  expect(await submitCode(d2.page, await nextCode(second.secret))).toBe(302);
  await d2.page.waitForURL((u) => isIdp(u) && u.pathname === "/account/mfa", { waitUntil: "load" });
  await off.getByLabel("Current password").fill(account.password);
  await off.getByLabel("Authenticator code or recovery code").fill(second.codes[3]!);
  await off.getByRole("button", { name: "Turn off two-step verification" }).click();
  await expect(d2.page.getByRole("heading", { name: "Two-step verification is off" })).toBeVisible();
  await passwordStep(d2.page, account);
  await onHome(d2.page);
  await d2.context.close();
});

test("mfa: federation (mock Google) of an enrolled account => step 2 page, no session before the code", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const identity = { sub: `e2e-mfa-g-${randomUUID()}`, email: `e2e-mfa-fed-${randomUUID()}@example.com` };
  // Social sign-in is offered only on a resumable login (an RP `/authorize`), so start at fe-sso-test.
  const google = async (page: Page) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => isIdp(u) && u.pathname === "/login", { waitUntil: "load" });
    await page.getByRole("link", { name: "Sign in with Google" }).click();
    await page.waitForURL((u) => u.hostname === "127.0.0.1" && u.pathname === "/authorize", { waitUntil: "load" });
    await page.getByLabel("Subject").fill(identity.sub);
    await page.getByLabel("Email", { exact: true }).fill(identity.email);
    await page.getByRole("button", { name: "Continue" }).click();
  };

  // New federated account (no password) signs in to the RP, then enrolls in a fresh session.
  const a = await fresh(browser);
  await google(a.page);
  await approveConsentUntil(a.page, a.page.getByTestId("claim-sub"));
  await a.page.goto(`${ISSUER}/account/mfa`);
  const { secret } = await enroll(a.page, identity.email);
  await a.context.close();

  // Same Google identity: the callback stops at step 2 with no session; the code completes the RP sign-in.
  const b = await fresh(browser);
  await google(b.page);
  await onStep2(b.page);
  await expectNoSession(b.context);
  expect(await submitCode(b.page, await nextCode(secret))).toBe(302);
  await approveConsentUntil(b.page, b.page.getByTestId("claim-sub"));
  await b.page.goto(`${ISSUER}/account/sessions`);
  await expect(b.page.getByText("+ authenticator").first()).toBeVisible();
  await b.context.close();
});

test.describe.serial("mfa: E2E_MFA_USER and the admin console", () => {
  const user: Account = { email: E2E_MFA_USER_EMAIL, password: E2E_MFA_USER_PASSWORD };

  test("(e) not enrolled => fe-admin sign-in stops at 'Two-step verification required'; enroll from there => back through step 2", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { context, page } = await fresh(browser);
    let callback = false;
    let gateStatus = 0;
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (isAdminApp(u) && u.pathname === "/auth/callback") callback = true;
    });
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (isIdp(u) && u.pathname === "/authorize" && r.request().isNavigationRequest()) gateStatus = r.status();
    });
    await page.goto(`${FE_ADMIN_URL}/`);
    await page.waitForURL((u) => isIdp(u) && u.pathname === "/login", { waitUntil: "load" });
    const form = page.locator('form[action="/login"]');
    await form.getByLabel("Email").fill(user.email);
    await form.getByLabel("Password").fill(user.password);
    await form.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Two-step verification required" })).toBeVisible();
    expect(gateStatus, "the gate page is a 403").toBe(403);
    expect(callback, "no code reached fe-admin").toBe(false);

    await page.getByRole("link", { name: "Set up two-step verification" }).click();
    await page.waitForURL((u) => isIdp(u) && u.pathname === "/account/mfa", { waitUntil: "load" });
    await enroll(page, user.email);
    await page.getByRole("link", { name: "Continue" }).click();
    await page.waitForURL((u) => isIdp(u) && u.pathname === "/login", { waitUntil: "load" });
    await form.getByLabel("Email").fill(user.email);
    await form.getByLabel("Password").fill(user.password);
    await form.getByRole("button", { name: "Sign in" }).click();
    await onStep2(page);
    await passSecondFactor(page, user.email);
    // Back on the original authorization: consent, then fe-admin (no admin role => its 403 page).
    const consent = page.locator('form[action="/authorize/consent"]');
    const denied = page.getByRole("heading", { name: "Access denied" });
    for (let i = 0; i < 3; i++) {
      await expect(consent.or(denied).first()).toBeVisible({ timeout: 30_000 });
      if (await denied.isVisible()) break;
      await consent.getByRole("button", { name: "Allow" }).click();
      await consent.waitFor({ state: "detached" });
    }
    await expect(page.getByTestId("viewer-email")).toHaveText(user.email);
    expect(callback, "fe-admin callback reached after step 2").toBe(true);
    await context.close();
  });

  test("(g) admin resets the second factor in fe-admin => the user signs in with the password only, then enrolls again", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const { context, page } = await fresh(browser);
    await page.goto(`${FE_ADMIN_URL}/users`);
    await signInAsAdmin(page);
    await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeVisible();
    await page.waitForFunction(() => {
      const el = document.getElementById("users-email");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber"));
    });
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByRole("button", { name: "Filter" }).click();
    const table = page.getByRole("table", { name: "Users" });
    await expect(table.getByRole("row")).toHaveCount(2);
    await table.getByRole("link", { name: user.email }).click();
    await page.waitForURL((u) => isAdminApp(u) && u.pathname.startsWith("/users/"));
    const account = page.getByRole("region", { name: "Account" });
    await expect(account.getByText(/^On \(since /)).toBeVisible();
    await account.getByRole("button", { name: "Reset two-step verification" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(account.getByText("Off", { exact: true })).toBeVisible();
    await context.close();

    // Password only now; then enroll again.
    const u = await fresh(browser);
    await passwordStep(u.page, user, "/account/mfa");
    await u.page.waitForURL((x) => isIdp(x) && x.pathname === "/account/mfa", { waitUntil: "load" });
    await expect(u.page.getByText("Two-step verification is off.")).toBeVisible();
    const again = await enroll(u.page, user.email);
    await passwordStep(u.page, user);
    await onStep2(u.page);
    expect(await submitCode(u.page, await nextCode(again.secret))).toBe(302);
    await onHome(u.page);
    await u.context.close();
  });
});
