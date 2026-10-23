import { expect, type Page } from "@playwright/test";
import { ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, BE_PORT, FE_ADMIN_PORT } from "../../config/env";

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
