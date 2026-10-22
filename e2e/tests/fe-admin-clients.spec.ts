import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, BE_PORT, FE_ADMIN_PORT, FE_ADMIN_URL } from "../config/env";
import { adminApi, adminToken } from "./support/admin";

/**
 * DEBT-281 (run 44 Task 3E): step-up round-trip on the real fe-admin. Sign in, create a client with
 * the form, then edit its redirect URIs once the BFF has refreshed the access token: a refresh-grant
 * AT has no `auth_time`, so the admin API answers `403 step_up_required` (no test-only branch in
 * production code). The E2E stack runs with `ACCESS_TOKEN_TTL=120` (config/env.ts) and the BFF
 * refreshes 60 s before expiry, so the wait is about a minute. Back from the IdP
 * (`prompt=login&max_age=0`) the draft is restored but NOT sent; saving then succeeds. The client
 * is created fresh every run (server-generated id) and disabled through the admin API at the end.
 */

const isIdp = (url: URL) => url.port === String(BE_PORT);
const isAdminApp = (url: URL) => url.port === String(FE_ADMIN_PORT);

/** On the IdP login page: sign the E2E admin in (and approve consent) until back on fe-admin. */
async function signInAsAdmin(page: Page): Promise<void> {
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

/** The client as the admin API sees it (separate browser context, read-only token). */
async function readClient(page: Page, clientId: string): Promise<{ redirectUris: string[] }> {
  const ctx = await page.context().browser()!.newContext();
  try {
    const { accessToken } = await adminToken(ctx);
    const res = await adminApi(accessToken, "GET", `/clients/${encodeURIComponent(clientId)}`);
    expect(res.status, "admin API read").toBe(200);
    return res.body as { redirectUris: string[] };
  } finally {
    await ctx.close();
  }
}

test("fe-admin clients: create, then edit redirect URIs through a step-up round-trip", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const host = `e2e-${randomBytes(4).toString("hex")}.example`;
  const cb1 = `https://${host}/cb`;
  const cb2 = `https://${host}/cb2`;
  let clientId: string | undefined;
  try {
    // 1. Sign in (fresh auth_time) and create a client with the form: no step-up needed yet.
    await page.goto(`${FE_ADMIN_URL}/clients/new`);
    await signInAsAdmin(page);
    const signedInAt = Date.now();
    await expect(page.getByRole("heading", { name: "New client" })).toBeVisible();
    // Hydrated: the resource list is loaded by the browser (the SSR HTML shows "Loading resources…").
    await expect(page.getByRole("checkbox", { name: /^admin/ })).toBeVisible();
    await page.getByLabel("Redirect URIs", { exact: true }).fill(cb1);
    await page.getByRole("button", { name: "Create client" }).click();
    await page.waitForURL((u) => isAdminApp(u) && /^\/clients\/[^/]+$/.test(u.pathname) && u.pathname !== "/clients/new");
    clientId = decodeURIComponent(new URL(page.url()).pathname.split("/")[2]!);
    await expect(page.getByLabel("Redirect URIs", { exact: true })).toHaveValue(cb1);

    // 2. Once the BFF refreshes (AT TTL 120 s - skew 60 s), the write is refused => step-up.
    await page.waitForTimeout(Math.max(0, signedInAt + 65_000 - Date.now()));
    await page.getByLabel("Redirect URIs", { exact: true }).fill(`${cb1}\n${cb2}`);
    const reauth = page.waitForRequest((req) => {
      const url = new URL(req.url());
      return (
        isIdp(url) &&
        url.pathname === "/authorize" &&
        url.searchParams.get("prompt") === "login" &&
        url.searchParams.get("max_age") === "0"
      );
    });
    await page.getByRole("button", { name: "Save changes" }).click();
    await reauth;
    await signInAsAdmin(page);

    // 3. Back on the same page: the draft is restored and NOT sent.
    await page.waitForURL((u) => isAdminApp(u) && u.pathname === `/clients/${encodeURIComponent(clientId!)}`);
    await expect(page.getByLabel("Redirect URIs", { exact: true })).toHaveValue(`${cb1}\n${cb2}`);
    await expect(page.getByText("Check the values, then submit again.")).toBeVisible();
    expect((await readClient(page, clientId)).redirectUris, "nothing sent before the admin confirms").toEqual([cb1]);
    const storage = await page.evaluate(() => ({
      stepUp: sessionStorage.getItem("fea:stepup"),
      all: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    }));
    expect(storage.stepUp, "draft is single-use").toBeNull();
    expect(storage.all.includes("eyJ") || /token/i.test(storage.all), "no token in Web Storage").toBe(false);

    // 4. Save => success; the detail shows the new URIs (also after a reload) and the BE has them.
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Redirect URIs", { exact: true })).toHaveValue(`${cb1}\n${cb2}`);
    expect((await readClient(page, clientId)).redirectUris).toEqual([cb1, cb2]);
  } finally {
    await context.close();
    if (clientId) {
      const ctx = await browser.newContext();
      try {
        const admin = await adminToken(ctx, { forceLogin: true });
        const res = await adminApi(admin.accessToken, "PATCH", `/clients/${encodeURIComponent(clientId)}`, { disabled: true });
        expect(res.status, "E2E client disabled").toBe(200);
      } finally {
        await ctx.close();
      }
    }
  }
});
