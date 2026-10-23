import { test, expect } from "@playwright/test";
import { E2E_USER_EMAIL, FE_ADMIN_URL } from "../config/env";
import { adminApi, adminToken } from "./support/admin";
import { signInAsAdmin } from "./support/fe-admin";

/**
 * Run 50 Task 3 (A6.6): the fe-admin dashboard shows the admin API's real data. Expected values are
 * read from the admin API (token in its own context): one page of 100 per list => `n` or `100+`, and
 * the active signing key (the E2E admin is a super_admin). The seeded `E2E_USER_EMAIL` is locked then
 * unlocked so a fresh `ADMIN_USER_LOCKED` event exists; the dashboard lists it with a link to the
 * filtered audit log. IdP status is "Up". The URL has no query; the page text holds no JWT (`eyJ`),
 * no dependency name and not the E2E user's email. Nothing is flushed (the suite runs with 1 worker,
 * so the counts do not move between the API read and the page read).
 */
test("fe-admin dashboard: counts, signing key, IdP status and a fresh lock event match the admin API", async ({ browser }) => {
  test.setTimeout(120_000);

  const apiContext = await browser.newContext();
  const { accessToken } = await adminToken(apiContext).finally(() => apiContext.close());
  const found = await adminApi(accessToken, "GET", `/users?email=${encodeURIComponent(E2E_USER_EMAIL)}`);
  expect(found.status).toBe(200);
  const userId = (found.body.items as { id: string }[])[0]?.id;
  expect(typeof userId === "string", "target seeded (seed:e2e-admin)").toBe(true);

  const countOf = async (path: string) => {
    const res = await adminApi(accessToken, "GET", `${path}?limit=100`);
    expect(res.status, path).toBe(200);
    return res.body.nextCursor === null ? String((res.body.items as unknown[]).length) : "100+";
  };

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    expect((await adminApi(accessToken, "POST", `/users/${userId}/lock`)).status).toBe(200);
    expect((await adminApi(accessToken, "POST", `/users/${userId}/unlock`)).status).toBe(200);

    const expected = {
      "Clients (this tenant)": await countOf("/clients"),
      "Users (this tenant)": await countOf("/users"),
      "Resources (all tenants)": await countOf("/resources"),
    };
    const keys = await adminApi(accessToken, "GET", "/keys");
    expect(keys.status).toBe(200);
    const activeKid = (keys.body.items as { kid: string; status: string }[]).find((k) => k.status === "active")?.kid;
    expect(typeof activeKid === "string", "an active signing key").toBe(true);

    await page.goto(`${FE_ADMIN_URL}/`);
    await signInAsAdmin(page);
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();

    for (const [name, text] of Object.entries(expected)) {
      const card = page.getByRole("region", { name });
      await expect(card.getByText(text, { exact: true }), `${name} = ${text}`).toBeVisible();
      if (text === "100+") await expect(card.getByText("More than 100")).toBeAttached();
    }
    await expect(page.getByRole("region", { name: "Signing keys" }).getByText(activeKid!, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Identity provider status" }).getByRole("status"),
    ).toHaveText("Identity provider: Up");

    const events = page.getByRole("region", { name: "Recent security events" });
    const row = events.getByRole("listitem").filter({ hasText: "ADMIN_USER_LOCKED" }).filter({ hasText: userId! }).first();
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: /View in audit log/ })).toHaveAttribute("href", "/audit?action=ADMIN_USER_LOCKED");

    const url = new URL(page.url());
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    const text = await page.locator("body").innerText();
    expect(text.includes("eyJ"), "the page text has no JWT").toBe(false);
    expect(/mongo|redis/i.test(text), "the page text has no dependency name").toBe(false);
    expect(text.toLowerCase().includes(E2E_USER_EMAIL.toLowerCase()), "the page text has no E2E email").toBe(false);
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
