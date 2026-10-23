import { expect, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, BE_PORT, FE_ADMIN_PORT, FE_ADMIN_URL } from "../../config/env";

export const isIdp = (url: URL) => url.port === String(BE_PORT);
export const isAdminApp = (url: URL) => url.port === String(FE_ADMIN_PORT);

/** On the IdP login page: sign the E2E admin in (and approve consent) until back on fe-admin. */
export async function signInAsAdmin(page: Page): Promise<void> {
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
