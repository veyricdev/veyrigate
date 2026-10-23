import { test, expect, type Page } from "@playwright/test";
import { E2E_USER_EMAIL, E2E_USER_PASSWORD, FE_ADMIN_URL } from "../config/env";
import { adminApi, adminRefresh, adminToken } from "./support/admin";
import { expectSignInBlocked, isAdminApp, signInAsAdmin } from "./support/fe-admin";

/**
 * Run 47 Task 5 (A6.3): users on the real fe-admin. Target = the seeded `E2E_USER_EMAIL` (no admin
 * role, reset by `seed:e2e-admin` every run): it signs in as `fe-admin` (own context each time) to
 * hold a refresh token, then the admin finds it by email (never in a URL), locks it (old refresh
 * token refused, sign-in blocked), unlocks it, revokes one refresh token family, then every session.
 *
 * Every UI write must happen within ~50 s of the admin sign-in: the E2E stack runs
 * `ACCESS_TOKEN_TTL=120` and the BFF refreshes 60 s before expiry; a refresh-grant AT has no
 * `auth_time` => step-up (covered by component tests, not here). No token or password is logged.
 */
test("fe-admin users: filter by email, lock blocks refresh + sign-in, unlock, revoke family, revoke all", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const target = async () => {
    const ctx = await browser.newContext();
    return adminToken(ctx, { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD }).finally(() => ctx.close());
  };
  const refused = async (refreshToken: string, what: string) =>
    expect((await adminRefresh(refreshToken)).status, `${what}: refresh token refused`).toBe(400);

  // Admin API token (own context) to find the target and clean up; read + cleanup only.
  const apiContext = await browser.newContext();
  const { accessToken } = await adminToken(apiContext).finally(() => apiContext.close());
  const found = await adminApi(accessToken, "GET", `/users?email=${encodeURIComponent(E2E_USER_EMAIL)}`);
  expect(found.status).toBe(200);
  const userId = (found.body.items as { id: string }[])[0]?.id;
  expect(typeof userId === "string", "target seeded (seed:e2e-admin)").toBe(true);
  // A previous failed run may have left a family alive: start from none.
  expect((await adminApi(accessToken, "POST", `/users/${userId}/sessions/revoke`)).status).toBe(204);

  // 1. Target signs in => RT0.
  const rt0 = (await target()).refreshToken;

  const context = await browser.newContext();
  const page = await context.newPage();
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  try {
    // 2. Admin: /users => filter by email => detail => Lock.
    await page.goto(`${FE_ADMIN_URL}/users`);
    await signInAsAdmin(page);
    const signedInAt = Date.now();
    await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeVisible();
    await page.waitForFunction(() => {
      const el = document.getElementById("users-email");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber"));
    });
    await page.getByLabel("Email", { exact: true }).fill(E2E_USER_EMAIL);
    await page.getByRole("button", { name: "Filter" }).click();
    const table = page.getByRole("table", { name: "Users" });
    await expect(table.getByRole("row")).toHaveCount(2);
    await table.getByRole("link", { name: E2E_USER_EMAIL }).click();
    await page.waitForURL((u) => isAdminApp(u) && u.pathname === `/users/${userId}`);
    expect(page.url().includes("e2e-user"), "the email is not in the URL").toBe(false);
    expect(requested.filter((u) => u.includes("e2e-user") || u.includes("e2e%2Duser")), "no request URL holds the email").toEqual([]);

    const account = page.getByRole("region", { name: "Account" });
    await expect(account.getByText("Not locked", { exact: true })).toBeVisible();
    await confirm(page, account.getByRole("button", { name: "Lock", exact: true }), "Lock account");
    await expect(account.getByRole("status")).toHaveText("Account locked. Every session and refresh token was ended.");
    await expect(account.getByText("Locked by an administrator (until unlocked)", { exact: true })).toBeVisible();

    // 3. RT0 refused; the target cannot sign in.
    await refused(rt0, "after lock");
    const blocked = await browser.newContext();
    await expectSignInBlocked(blocked, E2E_USER_EMAIL, E2E_USER_PASSWORD).finally(() => blocked.close());

    // 4. Unlock => Not locked; the target signs in again => RT1.
    await confirm(page, account.getByRole("button", { name: "Unlock", exact: true }), "Unlock");
    await expect(account.getByRole("status")).toHaveText("Account unlocked.");
    await expect(account.getByText("Not locked", { exact: true })).toBeVisible();
    const rt1 = (await target()).refreshToken;

    // 5. Reload => revoke the (only) active family => RT1 refused.
    await page.reload();
    const families = page.getByRole("region", { name: "Refresh token families" });
    const revoke = families.getByRole("button", { name: "Revoke family of fe-admin" });
    // Families are sorted by id (revoked ones of older runs too): page until the active one.
    for (let i = 0; ; i++) {
      await expect(families.getByRole("table").or(families.getByText(/^No (more families|refresh token family)\.$/))).toBeVisible();
      if ((await revoke.count()) > 0) break;
      expect(i < 20, "an active family within 20 pages").toBe(true);
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/_serverFn/")),
        families.getByRole("button", { name: "Next page" }).click(),
      ]);
    }
    await expect(revoke).toHaveCount(1);
    await confirm(page, revoke, "Revoke family");
    await expect(families.getByRole("status")).toHaveText("Refresh token family revoked.");
    await refused(rt1, "after family revoke");

    // 6. The target signs in => RT2; Revoke all sessions => RT2 refused.
    const rt2 = (await target()).refreshToken;
    await confirm(page, account.getByRole("button", { name: "Revoke all sessions" }), "Revoke all sessions");
    await expect(account.getByRole("status")).toHaveText("Every session and refresh token of this account was ended.");
    expect(Date.now() - signedInAt, "writes done before the BFF refresh (no step-up)").toBeLessThan(50_000);
    await refused(rt2, "after revoke all");
  } finally {
    await context.close();
    // The seed resets it next run anyway; never leave it locked for the specs that follow.
    await adminApi(accessToken, "POST", `/users/${userId}/unlock`).catch(() => undefined);
  }
});

/** Click `trigger`, then the confirm button of the dialog it opens. */
async function confirm(page: Page, trigger: ReturnType<Page["getByRole"]>, confirmLabel: string): Promise<void> {
  await trigger.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
