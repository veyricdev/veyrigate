import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN_SEED_EMAIL, DEV_SEED_EMAIL, E2E_USER_EMAIL, E2E_USER_PASSWORD, FE_ADMIN_URL } from "../config/env";
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
    // Other specs expect the target without roles.
    await resetRoles(browser, userId, []);
  }
});

/**
 * Run 77 Task 6 (DEBT-494): a REAL tenant_admin session on fe-admin. The target `E2E_USER_EMAIL`
 * gets `tenant_admin` through the API and signs in to fe-admin: the UX gates hold (own roles, a
 * super_admin's roles and account, no Super admin checkbox), and a BFF request rewritten in the
 * browser to grant `super_admin` to the dev user is refused by the BE (403, fixed text): the BFF only
 * forwards the viewer's own token (no confused deputy). The dev user's roles never change. Direct
 * BE PATCH with a tenant_admin token is covered by `be/test/admin-users.int-spec.ts`. No token or
 * password is logged.
 */
test("fe-admin roles: a tenant_admin viewer gets the gates, and a tampered BFF request is refused (403)", async ({ browser }) => {
  test.setTimeout(120_000);
  const idOf = async (token: string, email: string) => {
    const found = await adminApi(token, "GET", `/users?email=${encodeURIComponent(email)}`);
    expect(found.status).toBe(200);
    const id = (found.body.items as { id: string }[])[0]?.id;
    expect(typeof id === "string", `${email} seeded`).toBe(true);
    return id;
  };
  const rolesOf = async (token: string, id: string) => (await adminApi(token, "GET", `/users/${id}`)).body.roles as string[];

  // 1-2. Ids, both seeded without an admin role, then the target becomes tenant_admin (API).
  const token = await freshAdminToken(browser);
  const target = await idOf(token, E2E_USER_EMAIL);
  const adminSeed = await idOf(token, ADMIN_SEED_EMAIL);
  const dev = await idOf(token, DEV_SEED_EMAIL);
  let context: BrowserContext | undefined;
  try {
    expect(await rolesOf(token, dev), "dev user seeded without admin role").toEqual([]);
    expect(await rolesOf(token, target)).toEqual([]);
    expect((await adminApi(token, "PATCH", `/users/${target}/roles`, { roles: ["tenant_admin"] })).status).toBe(200);
    context = await browser.newContext();
    const page = await context.newPage();

    // 3. The tenant_admin signs in to fe-admin.
    await page.goto(`${FE_ADMIN_URL}/users`);
    await signInAsAdmin(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);
    const roles = page.getByRole("region", { name: "Admin roles" });

    // Own roles: no form.
    await page.goto(`${FE_ADMIN_URL}/users/${target}`);
    await expect(roles.getByText("You cannot change your own roles.", { exact: true })).toBeVisible();
    await expect(roles.getByRole("checkbox")).toHaveCount(0);

    // A super_admin: no roles form, no account write.
    await page.goto(`${FE_ADMIN_URL}/users/${adminSeed}`);
    await expect(roles.getByText("Only a super admin can change the roles of a super admin.", { exact: true })).toBeVisible();
    await expect(roles.getByRole("checkbox")).toHaveCount(0);
    const account = page.getByRole("region", { name: "Account" });
    await expect(account.getByText("Only a super admin can change this account.", { exact: true })).toBeVisible();
    await expect(account.getByRole("button", { name: "Lock", exact: true })).toHaveCount(0);

    // The dev user: only the Tenant admin checkbox.
    await page.goto(`${FE_ADMIN_URL}/users/${dev}`);
    const tenantAdmin = roles.getByRole("checkbox", { name: "Tenant admin", exact: true });
    await expect(tenantAdmin).toBeVisible();
    await expect(roles.getByRole("checkbox")).toHaveCount(1);
    await expect(roles.getByRole("checkbox", { name: /super admin/i })).toHaveCount(0);

    // The BFF request is rewritten to grant super_admin: the BE refuses the viewer's token.
    let tampered = 0;
    await page.route(
      (u) => isAdminApp(u) && u.pathname.startsWith("/_serverFn"),
      (route) => {
        const body = route.request().postData() ?? "";
        if (route.request().method() !== "POST" || !body.includes(dev) || !body.includes("tenant_admin")) return route.continue();
        tampered++;
        return route.continue({ postData: body.replaceAll("tenant_admin", "super_admin") });
      },
    );
    await expect(tenantAdmin).not.toBeChecked();
    await tenantAdmin.check();
    await roles.getByRole("button", { name: "Save roles" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Change roles", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "You cannot make this change: only a super admin can grant or remove super admin or change a super admin, and nobody can change their own roles.",
    );
    expect(tampered, "exactly one BFF request rewritten").toBe(1);
    expect(await rolesOf(await freshAdminToken(browser), dev)).toEqual([]);
  } finally {
    // Back to the seed baseline (no admin role) whatever failed, even a dirty state from an earlier run.
    await context?.close();
    await resetRoles(browser, target, []);
    const fresh = await freshAdminToken(browser).catch(() => undefined);
    const devNow = fresh ? await rolesOf(fresh, dev).catch(() => undefined) : undefined;
    if (JSON.stringify(devNow) !== "[]") await resetRoles(browser, dev, []);
  }
});

/** A FRESH super_admin access token (an earlier one may have expired), in its own context. */
async function freshAdminToken(browser: Browser): Promise<string> {
  const ctx = await browser.newContext();
  return (await adminToken(ctx).finally(() => ctx.close())).accessToken;
}

/**
 * Cleanup: set the admin roles of `userId` with a fresh super_admin token. Never throws; a failure
 * is a fixed warning (status only: no error text, token or body).
 */
async function resetRoles(browser: Browser, userId: string, roles: string[]): Promise<void> {
  try {
    const { status } = await adminApi(await freshAdminToken(browser), "PATCH", `/users/${userId}/roles`, { roles });
    if (status !== 200) {
      console.warn(`fe-admin-roles cleanup: PATCH roles answered ${status}; a seeded user may keep an admin role`);
    }
  } catch {
    console.warn("fe-admin-roles cleanup: failed before an answer; a seeded user may keep an admin role");
  }
}

/** "Save roles", check the dialog lists `change`, confirm; the dialog closes. */
async function save(page: Page, roles: ReturnType<Page["getByRole"]>, change: string): Promise<void> {
  await roles.getByRole("button", { name: "Save roles" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText(change, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Change roles", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
