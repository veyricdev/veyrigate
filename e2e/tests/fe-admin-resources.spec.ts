import { test, expect } from "@playwright/test";
import { FE_ADMIN_URL } from "../config/env";
import { adminApi, adminToken } from "./support/admin";
import { isAdminApp, signInAsAdmin } from "./support/fe-admin";

/**
 * Run 46 Task 4 (A6.2): resources on the real fe-admin. An invalid identifier is blocked in the
 * form (no request, nothing at the BE), a valid one is created, listed on page 1, then its scopes
 * are edited and the admin API reflects them (identifier unchanged).
 *
 * Data: resources cannot be deleted (no DELETE endpoint) and the E2E DB is never reset, so each
 * run creates ONE new resource `e2e-r<inv>` (`inv` = 9999999999999 - now, so the newest run has
 * the smallest `https://e2e-r…` identifier and is always on page 1) and leaves it there (DEBT-322).
 *
 * Every write must happen within ~50 s of the sign-in: the E2E stack runs `ACCESS_TOKEN_TTL=120`
 * and the BFF refreshes 60 s before expiry; a refresh-grant AT has no `auth_time` => step-up
 * (covered by fe-admin-clients.spec.ts, not here).
 */
test("fe-admin resources: invalid identifier blocked, create, list, edit scopes", async ({ browser }) => {
  test.setTimeout(120_000);
  const inv = String(9_999_999_999_999 - Date.now()).padStart(13, "0");
  const resourceId = `e2e-r${inv}`;
  const identifier = `https://${resourceId}.resources.test/api`;
  const readResource = async () => adminApi(accessToken, "GET", `/resources/${encodeURIComponent(resourceId)}`);

  // Read-only admin API token first (own context): the fe-admin sign-in below starts the clock.
  const apiContext = await browser.newContext();
  const { accessToken } = await adminToken(apiContext).finally(() => apiContext.close());

  const context = await browser.newContext();
  const page = await context.newPage();
  const serverFnPosts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/_serverFn/")) serverFnPosts.push(req.url());
  });
  try {
    await page.goto(`${FE_ADMIN_URL}/resources/new`);
    await signInAsAdmin(page);
    const signedInAt = Date.now();
    await expect(page.getByRole("heading", { name: "New resource" })).toBeVisible();
    // Hydrated (React owns the field): a click before that would be a native submit.
    await page.waitForFunction(() => {
      const el = document.getElementById("resource-identifier");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber"));
    });

    // 1. Identifier with a fragment: field error, no request, nothing at the BE.
    await page.getByLabel("Resource ID").fill(resourceId);
    await page.getByLabel("Identifier").fill(`${identifier}#frag`);
    await page.getByRole("button", { name: "Create resource" }).click();
    await expect(page.getByText("Must not contain a fragment")).toBeVisible();
    await expect(page.getByLabel("Identifier")).toHaveAttribute("aria-invalid", "true");
    await page.waitForTimeout(500);
    expect(serverFnPosts, "no create request for an invalid identifier").toEqual([]);
    expect((await readResource()).status, "not created").toBe(404);

    // 2. Valid identifier + scopes => created, detail page.
    await page.getByLabel("Identifier").fill(identifier);
    await page.getByLabel("Scopes").fill("e2e.read e2e.write");
    await page.getByRole("button", { name: "Create resource" }).click();
    await page.waitForURL((u) => isAdminApp(u) && u.pathname === `/resources/${resourceId}`);
    expect(serverFnPosts).toHaveLength(1);
    await expect(page.getByLabel("Scopes")).toHaveValue("e2e.read e2e.write");
    await expect(page.getByText(identifier, { exact: true })).toBeVisible();

    // 3. Listed on page 1 (identifier ascending: the newest e2e run sorts first among them).
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Resources" }).click();
    const table = page.getByRole("table", { name: "Resources" });
    await expect(table.getByRole("link", { name: resourceId })).toBeVisible();
    await expect(table.getByText(identifier, { exact: true })).toBeVisible();

    // 4. Edit the scopes => the BE has exactly them; the identifier is unchanged.
    await table.getByRole("link", { name: resourceId }).click();
    await page.waitForURL((u) => isAdminApp(u) && u.pathname === `/resources/${resourceId}`);
    await page.getByLabel("Scopes").fill("e2e.read e2e.admin");
    await page.getByRole("button", { name: "Save scopes" }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    expect(Date.now() - signedInAt, "writes done before the BFF refresh (no step-up)").toBeLessThan(50_000);
    const saved = await readResource();
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ resourceId, identifier, scopes: ["e2e.read", "e2e.admin"] });
  } finally {
    await context.close();
  }
});
