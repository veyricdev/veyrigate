import { test, expect } from "@playwright/test";
import { E2E_USER_EMAIL, FE_ADMIN_URL } from "../config/env";
import { adminApi, adminToken } from "./support/admin";
import { isAdminApp, signInAsAdmin } from "./support/fe-admin";

/**
 * Run 48 Task 4 (A6.4): an admin write leaves a trail in `/audit`. The seeded `E2E_USER_EMAIL` is
 * locked then unlocked through the admin API (token in its own context), then the real fe-admin
 * filters `/audit` by action + target id + `from` (= start - 1 min: older runs' events are left out,
 * nothing is flushed). Neither the URL nor the page text holds the email or a JWT (`eyJ`).
 * Token reuse is covered by the BE int tests (run 48 Task 0b), not here.
 */
test("fe-admin audit: lock + unlock of the E2E user are listed under their filters", async ({ browser }) => {
  test.setTimeout(120_000);
  const start = new Date(Date.now() - 60_000);
  start.setMilliseconds(0);

  const apiContext = await browser.newContext();
  const { accessToken } = await adminToken(apiContext).finally(() => apiContext.close());
  const found = await adminApi(accessToken, "GET", `/users?email=${encodeURIComponent(E2E_USER_EMAIL)}`);
  expect(found.status).toBe(200);
  const userId = (found.body.items as { id: string }[])[0]?.id;
  expect(typeof userId === "string", "target seeded (seed:e2e-admin)").toBe(true);

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    expect((await adminApi(accessToken, "POST", `/users/${userId}/lock`)).status).toBe(200);
    expect((await adminApi(accessToken, "POST", `/users/${userId}/unlock`)).status).toBe(200);

    await page.goto(`${FE_ADMIN_URL}/audit`);
    await signInAsAdmin(page);
    await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();
    await page.waitForFunction(() => {
      const el = document.getElementById("audit-targetId");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber"));
    });

    // `datetime-local` takes local time (the browser runs on this machine's time zone).
    const local = new Date(start.getTime() - start.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    await page.getByLabel("Action").selectOption("ADMIN_USER_LOCKED");
    await page.getByLabel("Target id").fill(userId!);
    await page.getByLabel("From (local time)").fill(local);
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.waitForURL((u) => isAdminApp(u) && u.searchParams.get("action") === "ADMIN_USER_LOCKED");
    const url = new URL(page.url());
    expect(url.searchParams.get("targetId")).toBe(userId);
    expect(url.searchParams.get("from")).toBe(start.toISOString());

    const table = page.getByRole("table", { name: /Audit events/ });
    const locked = table.getByRole("row").filter({ hasText: "ADMIN_USER_LOCKED" }).first();
    await expect(locked).toBeVisible();
    await expect(locked.getByRole("link", { name: userId! })).toHaveAttribute("href", `/users/${userId}`);
    await locked.getByRole("button", { name: "Details" }).click();
    await expect(table.getByRole("definition").filter({ hasText: /^\d+$/ }).first()).toBeVisible();
    await expect(table.getByRole("term").filter({ hasText: /^count$/ }).first()).toBeVisible();

    await page.getByLabel("Action").selectOption("ADMIN_USER_UNLOCKED");
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.waitForURL((u) => isAdminApp(u) && u.searchParams.get("action") === "ADMIN_USER_UNLOCKED");
    await expect(table.getByRole("row").filter({ hasText: "ADMIN_USER_UNLOCKED" }).first()).toBeVisible();
    expect(new URL(page.url()).searchParams.get("targetId")).toBe(userId);

    const href = page.url();
    expect(href.includes("@") || href.includes("%40"), "no email in the URL").toBe(false);
    expect(href.toLowerCase()).not.toContain(E2E_USER_EMAIL.toLowerCase());
    const text = await page.locator("body").innerText();
    expect(text.includes(E2E_USER_EMAIL), "the page text has no E2E email").toBe(false);
    expect(text.includes("eyJ"), "the page text has no JWT").toBe(false);
  } finally {
    await context.close();
    // Best effort (the seed resets the user every run): a fresh token, the first may have expired.
    const cleanup = await browser.newContext();
    await adminToken(cleanup)
      .then(({ accessToken: fresh }) => adminApi(fresh, "POST", `/users/${userId}/unlock`))
      .catch(() => undefined)
      .finally(() => cleanup.close());
  }
});
