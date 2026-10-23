import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { FE_ADMIN_URL, ISSUER } from "../config/env";
import { adminApi, adminToken } from "./support/admin";
import { isAdminApp, signInAsAdmin } from "./support/fe-admin";

/**
 * Run 45 (A6.1b, F4): one-time client secret on the real fe-admin. A confidential
 * `client_secret_basic` client is created through the UI, a secret is issued, rotated and revoked,
 * and the client is disabled then enabled. Whether a secret works is checked with RFC 7009
 * `POST /revoke` (Basic auth, unknown random token): 200 = the client authenticated, 401 = not
 * (Q-45.1). Everything runs right after sign-in (fresh `auth_time`, no step-up). Secrets are never
 * logged and never put into an assertion message. The client is disabled at the end.
 */

/** `POST /revoke` with `client_id:secret` (Basic): the HTTP status only. */
async function clientAuth(clientId: string, secret: string): Promise<number> {
  const res = await fetch(`${ISSUER}/revoke`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: randomBytes(24).toString("base64url") }),
  });
  await res.body?.cancel();
  return res.status;
}

/** Everything the browser keeps for the page: HTML, Web Storage, URL. */
async function pageStores(page: Page): Promise<string> {
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  return `${await page.content()}\n${storage}\n${page.url()}`;
}

/** Click Issue/Rotate, confirm, read the one-time secret, close the dialog. */
async function issueThroughUi(page: Page, label: "Issue secret" | "Rotate secret"): Promise<{ secret: string; noStore: boolean }> {
  await page.getByRole("button", { name: label }).click();
  const dialog = page.getByRole("dialog");
  const answer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.startsWith("/_serverFn/"));
  await dialog.getByRole("button", { name: label }).click();
  const res = await answer;
  const code = dialog.getByTestId("issued-secret");
  await expect(code).toBeVisible();
  const secret = (await code.textContent()) ?? "";
  expect(secret.length > 20, "a secret is shown").toBe(true);
  const noStore = (res.headers()["cache-control"] ?? "").includes("no-store");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("issued-secret")).toHaveCount(0);
  return { secret, noStore };
}

test("fe-admin secrets: issue once, rotate, revoke a version, disable and enable", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const cb = `https://e2e-${randomBytes(4).toString("hex")}.example/cb`;
  let clientId: string | undefined;
  try {
    // 1. Sign in and create a confidential client_secret_basic client (the form defaults).
    await page.goto(`${FE_ADMIN_URL}/clients/new`);
    await signInAsAdmin(page);
    await expect(page.getByRole("heading", { name: "New client" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /^admin/ })).toBeVisible(); // hydrated
    await expect(page.getByRole("radio", { name: "client_secret_basic" })).toBeChecked();
    await page.getByLabel("Redirect URIs", { exact: true }).fill(cb);
    await page.getByRole("button", { name: "Create client" }).click();
    await page.waitForURL((u) => isAdminApp(u) && /^\/clients\/[^/]+$/.test(u.pathname) && u.pathname !== "/clients/new");
    clientId = decodeURIComponent(new URL(page.url()).pathname.split("/")[2]!);
    await expect(page.getByText("No secret yet.", { exact: false })).toBeVisible();

    // 2. Issue S1: shown once, answer not stored; it authenticates; gone after close and reload.
    const s1 = await issueThroughUi(page, "Issue secret");
    expect(s1.noStore, "issue answer has cache-control: no-store").toBe(true);
    expect(await clientAuth(clientId, s1.secret), "S1 authenticates").toBe(200);
    expect((await pageStores(page)).includes(s1.secret), "S1 not in HTML/storage/URL after close").toBe(false);
    await page.reload();
    await expect(page.getByRole("button", { name: "Rotate secret" })).toBeVisible();
    await expect(page.getByTestId("issued-secret")).toHaveCount(0);
    expect((await pageStores(page)).includes(s1.secret), "S1 not in HTML/storage/URL after reload").toBe(false);

    // 3. Rotate => S2; S1 (grace) and S2 both authenticate.
    const s2 = await issueThroughUi(page, "Rotate secret");
    expect(s2.noStore, "rotate answer has cache-control: no-store").toBe(true);
    expect(s2.secret === s1.secret, "S2 differs from S1").toBe(false);
    expect(await clientAuth(clientId, s1.secret), "S1 still works in grace").toBe(200);
    expect(await clientAuth(clientId, s2.secret), "S2 authenticates").toBe(200);

    // 4. Revoke version 1 through the UI => S1 refused, S2 still works.
    await page.getByRole("button", { name: "Revoke version 1" }).click();
    const revoke = page.getByRole("alertdialog");
    await expect(revoke).toContainText("no grace period");
    await revoke.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Version 1 revoked.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke version 1" })).toHaveCount(0);
    expect(await clientAuth(clientId, s1.secret), "revoked S1 refused").toBe(401);
    expect(await clientAuth(clientId, s2.secret), "S2 still works").toBe(200);

    // 5. Disable => S2 refused; enable => S2 works again.
    await page.getByRole("button", { name: "Disable client" }).click();
    const disable = page.getByRole("alertdialog");
    await expect(disable).toContainText("revokes every refresh token");
    await disable.getByRole("button", { name: "Disable client" }).click();
    await expect(page.getByText("Client disabled.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable client" })).toBeVisible();
    expect(await clientAuth(clientId, s2.secret), "disabled client refused").toBe(401);
    await page.getByRole("button", { name: "Enable client" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Enable client" }).click();
    await expect(page.getByText("Client enabled.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Disable client" })).toBeVisible();
    expect(await clientAuth(clientId, s2.secret), "enabled client authenticates").toBe(200);
    expect((await pageStores(page)).includes(s2.secret), "S2 not in HTML/storage/URL").toBe(false);
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
