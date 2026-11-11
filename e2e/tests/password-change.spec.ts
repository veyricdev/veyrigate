import { randomUUID } from "node:crypto";
import { test, expect, request, type Browser, type Page } from "@playwright/test";
import { BE_PORT, FE_PORT, ISSUER } from "../config/env";

/**
 * Self-service password change (run 85 T5/T6, DEBT-573/594, D85.6) on the real IdP UI. The spec
 * owns a DEDICATED user created through the real `/register` form + verification mail (Mailpit API
 * on the local dev container), so the shared seed password is never changed. Two browser contexts
 * A and B are signed in as that user; A changes the password:
 *  - CSRF: a POST without the form token is refused (403) and changes nothing;
 *  - a wrong current password is refused with a fixed sentence;
 *  - after the change every session is dead: A must sign in again, B's `/authorize?prompt=none`
 *    comes back to the RP with `login_required` (before: `consent_required`, i.e. B was signed in);
 *  - the old password is refused at `/login`, the new one signs in.
 * URL waits use pathname/port predicates only (no full-URL regex: DEBT-108).
 */

const MAILPIT = "http://localhost:8025";
const isIdp = (url: URL) => url.port === String(BE_PORT);

const email = `e2e-pwc-${randomUUID()}@example.com`;
const OLD = `E2e-Old#${randomUUID()}`;
const NEW = `E2e-New#${randomUUID()}`;

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

async function signIn(page: Page, password: string): Promise<void> {
  await page.goto(`${ISSUER}/login`);
  const form = page.locator('form[action="/login"]');
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in" }).click();
}

async function signedIn(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, OLD);
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/");
  await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
  return page;
}

/** `/authorize?prompt=none` for fe-sso-test in `page`; returns the `error` the RP callback got. */
async function silentError(page: Page): Promise<string | null> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "fe-sso-test",
    redirect_uri: `http://localhost:${FE_PORT}/callback`,
    scope: "openid",
    resource: `${ISSUER}/demo/`,
    state: `s-${randomUUID()}`,
    nonce: `n-${randomUUID()}`,
    // S256 of a throwaway verifier; no code is expected here (both outcomes are errors).
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    prompt: "none",
  });
  const callback = page.waitForRequest((req) => {
    const url = new URL(req.url());
    return url.port === String(FE_PORT) && url.pathname === "/callback";
  });
  await page.goto(`${ISSUER}/authorize?${params.toString()}`).catch(() => undefined);
  const url = new URL((await callback).url());
  expect(url.searchParams.get("code"), "prompt=none must not issue a code here").toBeNull();
  return url.searchParams.get("error");
}

test("password change: CSRF and wrong current refused; success kills every session, old password refused", async ({
  browser,
}) => {
  // Setup: the spec's own account through the real register form + verification mail.
  const setup = await (await browser.newContext()).newPage();
  await setup.goto(`${ISSUER}/register`);
  const reg = setup.locator('form[action="/register"]');
  await reg.getByLabel("Email").fill(email);
  await reg.getByLabel("Password").fill(OLD);
  await reg.getByRole("button", { name: "Create account" }).click();
  await expect(setup.getByText("a verification email has been sent")).toBeVisible();
  await setup.goto(await verificationLink(email));
  await setup.getByRole("button", { name: "Verify email" }).click();
  await expect(setup.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await setup.context().close();

  const a = await signedIn(browser);
  const b = await signedIn(browser);
  // B is signed in: prompt=none reaches the consent check (no consent yet), not login_required.
  expect(await silentError(b)).toBe("consent_required");

  // A opens the form from the home page.
  await a.getByRole("link", { name: "Change password" }).click();
  await a.waitForURL((url) => isIdp(url) && url.pathname === "/account/password");
  const form = a.locator('form[action="/account/password"]');

  // CSRF: the same session cookie, no form token => 403, nothing changed.
  const forged = await a.request.post(`${ISSUER}/account/password`, {
    form: { current_password: OLD, new_password: NEW },
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);
  // ...and with a made-up token.
  const forged2 = await a.request.post(`${ISSUER}/account/password`, {
    form: { _csrf: "forged-token", current_password: OLD, new_password: NEW },
    maxRedirects: 0,
  });
  expect(forged2.status()).toBe(403);
  expect(await silentError(b)).toBe("consent_required");

  // Wrong current password: fixed sentence, still on the form.
  await form.getByLabel("Current password").fill(`${OLD}-wrong`);
  await form.getByLabel("New password").fill(NEW);
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(a.getByRole("alert")).toHaveText("The current password is incorrect.");
  expect(await silentError(b)).toBe("consent_required");

  // Success.
  await a.locator('form[action="/account/password"]').getByLabel("Current password").fill(OLD);
  await a.locator('form[action="/account/password"]').getByLabel("New password").fill(NEW);
  await a.locator('form[action="/account/password"]').getByRole("button", { name: "Change password" }).click();
  await expect(a.getByText("Your password has been changed. Sign in again with your new password.")).toBeVisible();
  expect(a.url().includes(OLD) || a.url().includes(NEW), "password in URL").toBe(false);

  // A must sign in again; B's session is dead too.
  await a.goto(`${ISSUER}/`);
  await a.waitForURL((url) => isIdp(url) && url.pathname === "/login");
  expect(await silentError(b)).toBe("login_required");

  // Old password refused (generic failure, no session); new password signs in.
  const refused = a.waitForResponse((res) => {
    const url = new URL(res.url());
    return isIdp(url) && url.pathname === "/login" && res.request().method() === "POST";
  });
  await signIn(a, OLD);
  expect((await refused).status()).toBe(401);
  expect((await a.context().cookies(ISSUER)).some((c) => c.name === "idp_session" && c.value !== "")).toBe(false);
  await signIn(a, NEW);
  await a.waitForURL((url) => isIdp(url) && url.pathname === "/");
  await expect(a.getByRole("heading", { name: "Signed in" })).toBeVisible();

  await a.context().close();
  await b.context().close();
});
