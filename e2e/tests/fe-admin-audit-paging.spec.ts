import { test, expect, type Page } from "@playwright/test";
import { E2E_USER_EMAIL, FE_ADMIN_URL } from "../config/env";
import { adminApi, adminToken } from "./support/admin";
import { isAdminApp, signInAsAdmin } from "./support/fe-admin";

/**
 * Run 57 tester (DEBT-422): fe-admin `/audit` pages through the new `(timestamp, _id)` cursor.
 * 8 lock/unlock cycles of the seeded E2E user (= 24 events: LOCKED + SESSION_REVOKED + UNLOCKED)
 * are filtered by target id + `from`; page 1 (20 rows) + "Next page" (4 rows) must equal, row for
 * row, the full list read from the admin API (limit 100), with no repeat and no gap. A legacy
 * `{t,e}` cursor in the URL shows the error with a "First page" way back (never a crash).
 */
test("fe-admin audit paging: Next page walks the (timestamp,_id) cursor without repeat or gap", async ({ browser }) => {
  test.setTimeout(150_000);
  const start = new Date(Date.now() - 1_000);
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
    for (let k = 0; k < 8; k++) {
      expect((await adminApi(accessToken, "POST", `/users/${userId}/lock`)).status).toBe(200);
      expect((await adminApi(accessToken, "POST", `/users/${userId}/unlock`)).status).toBe(200);
    }
    const q = `targetId=${userId}&from=${encodeURIComponent(start.toISOString())}`;
    const all = await adminApi(accessToken, "GET", `/audit?${q}&limit=100`);
    expect(all.status).toBe(200);
    const expected = (all.body.items as { timestamp: string; action: string }[]).map(
      (e) => `${e.timestamp} ${e.action}`,
    );
    expect(expected.length).toBeGreaterThanOrEqual(24);
    expect(expected.length).toBeLessThanOrEqual(40);

    await page.goto(`${FE_ADMIN_URL}/audit?${q}`);
    await signInAsAdmin(page);
    await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();
    const table = page.getByRole("table", { name: /Audit events/ });
    const pagination = page.getByRole("navigation", { name: "Pagination" });

    const rowsOf = async (p: Page) => {
      const rows = p.getByRole("table", { name: /Audit events/ }).locator("tbody > tr:has(th[scope=row])");
      await expect(rows.first()).toBeVisible();
      const n = await rows.count();
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const ts = (await rows.nth(i).locator("th").innerText()).trim();
        const action = (await rows.nth(i).locator("td").first().innerText()).trim().split("\n")[0];
        out.push(`${ts} ${action}`);
      }
      return out;
    };

    const seen: string[] = [];
    const first = await rowsOf(page);
    expect(first).toHaveLength(20);
    seen.push(...first);
    for (let p = 0; p < 5; p++) {
      const next = pagination.getByRole("link", { name: "Next page" });
      if ((await next.count()) === 0) break;
      const before = page.url();
      await next.click();
      await page.waitForURL((u) => isAdminApp(u) && u.href !== before && u.searchParams.has("after"));
      await expect(pagination.getByRole("link", { name: "First page" })).toBeVisible();
      await expect(table).toBeVisible();
      seen.push(...(await rowsOf(page)));
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expected);

    // A pre-run-57 cursor `{t, e}` (still base64url, so the URL schema keeps it) => error + "First page".
    const legacy = Buffer.from(JSON.stringify({ t: Date.now(), e: "x" })).toString("base64url");
    await page.goto(`${FE_ADMIN_URL}/audit?${q}&after=${legacy}`);
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await alert.getByRole("link", { name: "First page" }).click();
    await page.waitForURL((u) => isAdminApp(u) && !u.searchParams.has("after"));
    expect(await rowsOf(page)).toEqual(expected.slice(0, 20));
  } finally {
    await context.close();
    const cleanup = await browser.newContext();
    await adminToken(cleanup)
      .then(({ accessToken: fresh }) => adminApi(fresh, "POST", `/users/${userId}/unlock`))
      .catch(() => undefined)
      .finally(() => cleanup.close());
  }
});
