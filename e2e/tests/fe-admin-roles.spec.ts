import { test, expect, type Page } from "@playwright/test";
import { E2E_USER_EMAIL, E2E_USER_PASSWORD, FE_ADMIN_URL } from "../config/env";
import { adminApi, adminToken } from "./support/admin";
import { isAdminApp, signInAsAdmin } from "./support/fe-admin";

/**
 * Run 70 Task 2 (A6.3b): admin roles on the real fe-admin. Target = the seeded `E2E_USER_EMAIL`
 * (membership `{active, roles: []}`, reset by `seed:e2e-admin` every run). Its own admin token is
 * refused by `GET /admin/users` (403); the seeded super_admin grants `tenant_admin` in the UI; a NEW
 * token of the target then lists users (200, the grant is in force); the role is removed in the UI
 * (API roles `[]`). The `finally` resets the roles to `[]` through the API whatever failed.
 *
 * Every UI write happens within ~50 s of the admin sign-in (`ACCESS_TOKEN_TTL=120`, see
 * `fe-admin-users.spec.ts`). The 409 "last super admin" only happens when two super admins demote
 * each other concurrently (the actor always survives): not deterministic here, covered by the
 * fe-admin component tests and the BE int/race tests of run 69. No token or password is logged.
 */
test("fe-admin roles: grant tenant_admin takes effect (403 -> 200), then remove it", async ({ browser }) => {
  test.setTimeout(120_000);
  const targetToken = async () => {
    const ctx = await browser.newContext();
    return (await adminToken(ctx, { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD }).finally(() => ctx.close())).accessToken;
  };

  const apiContext = await browser.newContext();
  const { accessToken } = await adminToken(apiContext).finally(() => apiContext.close());
  const found = await adminApi(accessToken, "GET", `/users?email=${encodeURIComponent(E2E_USER_EMAIL)}`);
  expect(found.status).toBe(200);
  const userId = (found.body.items as { id: string }[])[0]?.id;
  expect(typeof userId === "string", "target seeded (seed:e2e-admin)").toBe(true);
  const rolesOf = async () => (await adminApi(accessToken, "GET", `/users/${userId}`)).body.roles;
  expect(await rolesOf()).toEqual([]);

  // 1. Without an admin role the target is refused by the admin API.
  expect((await adminApi(await targetToken(), "GET", "/users")).status, "no admin role: 403").toBe(403);

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    // 2. Admin: /users => filter by email (never in a URL) => detail.
    await page.goto(`${FE_ADMIN_URL}/users`);
    await signInAsAdmin(page);
    const signedInAt = Date.now();
    await page.waitForFunction(() => {
      const el = document.getElementById("users-email");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber"));
    });
    await page.getByLabel("Email", { exact: true }).fill(E2E_USER_EMAIL);
    await page.getByRole("button", { name: "Filter" }).click();
    await page.getByRole("table", { name: "Users" }).getByRole("link", { name: E2E_USER_EMAIL }).click();
    await page.waitForURL((u) => isAdminApp(u) && u.pathname === `/users/${userId}`);

    // 3. Grant tenant_admin.
    const roles = page.getByRole("region", { name: "Admin roles" });
    const tenantAdmin = roles.getByRole("checkbox", { name: "Tenant admin", exact: true });
    await expect(tenantAdmin).not.toBeChecked();
    await tenantAdmin.check();
    await save(page, roles, "Grant: Tenant admin");
    await expect(roles.getByRole("status")).toHaveText("Roles updated. They apply on the user's next request.");
    await expect(tenantAdmin).toBeChecked();
    expect(await rolesOf()).toEqual(["tenant_admin"]);

    // 4. In force: a new token of the target lists the tenant's users.
    expect((await adminApi(await targetToken(), "GET", "/users")).status, "tenant_admin: 200").toBe(200);

    // 5. Remove it.
    await tenantAdmin.uncheck();
    await save(page, roles, "Remove: Tenant admin");
    await expect(tenantAdmin).not.toBeChecked();
    expect(Date.now() - signedInAt, "writes done before the BFF refresh (no step-up)").toBeLessThan(50_000);
    expect(await rolesOf()).toEqual([]);
  } finally {
    await context.close();
    // A fresh token (the first may have expired): other specs expect the target without roles.
    const cleanup = await browser.newContext();
    await adminToken(cleanup)
      .then(({ accessToken: fresh }) => adminApi(fresh, "PATCH", `/users/${userId}/roles`, { roles: [] }))
      .catch(() => undefined)
      .finally(() => cleanup.close());
  }
});

/** "Save roles", check the dialog lists `change`, confirm; the dialog closes. */
async function save(page: Page, roles: ReturnType<Page["getByRole"]>, change: string): Promise<void> {
  await roles.getByRole("button", { name: "Save roles" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText(change, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Change roles", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
