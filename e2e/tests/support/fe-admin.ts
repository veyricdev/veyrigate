import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, BE_PORT, FE_ADMIN_PORT, FE_ADMIN_URL } from "../../config/env";
import { markStale, nextCode, secretFor } from "./totp";

export const isIdp = (url: URL) => url.port === String(BE_PORT);
export const isAdminApp = (url: URL) => url.port === String(FE_ADMIN_PORT);

/** On the IdP login page: sign the E2E admin (or `account`) in (and approve consent) until back on fe-admin. */
export async function signInAsAdmin(page: Page, account = ADMIN_SEED_EMAIL, password = ADMIN_SEED_PASSWORD): Promise<void> {
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
  const form = page.locator('form[action="/login"]');
  await form.getByLabel("Email").fill(account);
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in" }).click();
  const consent = page.locator('form[action="/authorize/consent"]');
  const email = page.getByTestId("viewer-email");
  await passSecondFactorIfAsked(page, account, consent.or(email));
  for (let i = 0; i < 3; i++) {
    await expect(consent.or(email).first()).toBeVisible({ timeout: 30_000 });
    if (await email.isVisible()) return;
    await consent.getByRole("button", { name: "Allow" }).click();
    await consent.waitFor({ state: "detached" });
  }
}

export const mfaForm = (page: Page) => page.locator('form[action="/login/mfa"]');

/**
 * Run 89 (T6 AC2/AC4): on the IdP `/login/mfa` page, enter the next TOTP code of `email` (allocator
 * of `totp.ts`). A refused code (the step was used by another process, `E2E_REUSE=1`) => skip to a
 * fresh step and retry ONCE. Resolves after the POST answered 303; the redirect chain continues.
 */
export async function passSecondFactor(page: Page, email: string): Promise<void> {
  const secret = secretFor(email);
  if (!secret) throw new Error("passSecondFactor: no TOTP seed known for this account");
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = mfaForm(page);
    await form.getByLabel("Code").fill(await nextCode(secret));
    const [res] = await Promise.all([
      page.waitForResponse((r) => isIdp(new URL(r.url())) && new URL(r.url()).pathname === "/login/mfa" && r.request().method() === "POST"),
      form.getByRole("button", { name: "Verify" }).click(),
    ]);
    if (res.status() === 303) return;
    expect(res.status(), "a refused code re-renders step 2").toBe(400);
    await expect(page.getByRole("alert")).toBeVisible();
    markStale(secret);
  }
  throw new Error("passSecondFactor: the IdP refused two fresh codes");
}

/** After the password: step 2 when the IdP asks for it, else nothing (`next` = what shows up otherwise). */
export async function passSecondFactorIfAsked(page: Page, email: string, next: Locator): Promise<void> {
  await expect(next.or(mfaForm(page)).first()).toBeVisible({ timeout: 30_000 });
  if (await mfaForm(page).isVisible()) await passSecondFactor(page, email);
}

/**
 * The fe-admin sign-in of `email` is refused by the IdP (locked account): after submitting the
 * login form the browser is still on the IdP `/login` and never reached the fe-admin callback.
 */
export async function expectSignInBlocked(context: BrowserContext, email: string, password: string): Promise<void> {
  const page = await context.newPage();
  let callback = false;
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (isAdminApp(u) && u.pathname === "/auth/callback") callback = true;
  });
  try {
    await page.goto(`${FE_ADMIN_URL}/`);
    await page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
    const form = page.locator('form[action="/login"]');
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Password").fill(password);
    await Promise.all([page.waitForEvent("load"), form.getByRole("button", { name: "Sign in" }).click()]);
    await page.waitForTimeout(500);
    const url = new URL(page.url());
    expect(isIdp(url) && url.pathname === "/login", "still on the IdP login page").toBe(true);
    expect(callback, "the fe-admin callback was never reached").toBe(false);
  } finally {
    await page.close();
  }
}
