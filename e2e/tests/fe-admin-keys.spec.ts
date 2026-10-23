import { test, expect } from "@playwright/test";
import { FE_ADMIN_URL, ISSUER } from "../config/env";
import { signInAsAdmin } from "./support/fe-admin";

/**
 * Run 49 Task 4 (A6.5): a NORMAL key rotation on the real fe-admin. The new kid K2 becomes active,
 * the old K1 is retiring; both are in the public JWKS (no private member). A fresh sign-in right
 * after (context B) proves the fe-admin callback accepts an ID token signed with K2 although its
 * JWKS was fetched moments ago (`cooldownDuration: 0`, run 49 Q-49.3). The emergency dialog is only
 * opened, checked and cancelled: an emergency rotation is never sent here (BE int + FE unit cover it).
 *
 * Never with `E2E_REUSE=1`: the reused BE may use the dev key dir (`be/keys`). The E2E stack keeps
 * its keys in `e2e/.keys` (expired retiring keys are dropped by the next rotation; nothing flushed).
 */
test.skip(process.env.E2E_REUSE === "1", "rotation would hit the reused BE key dir");

interface Jwk {
  kid: string;
  [member: string]: unknown;
}

test("fe-admin signing keys: normal rotation, JWKS, fresh sign-in on the new key, emergency dialog cancelled", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const jwks = async () => {
    const res = await request.get(`${ISSUER}/jwks.json`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { keys: Jwk[] }).keys;
  };

  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const page = await a.newPage();
    await page.goto(`${FE_ADMIN_URL}/keys`);
    await signInAsAdmin(page);
    const table = page.getByRole("table", { name: "Signing keys" });
    const activeRow = table.getByRole("row").filter({ hasText: "Active — signs new tokens" });
    await expect(activeRow).toHaveCount(1);
    const k1 = (await activeRow.getByRole("rowheader").innerText()).trim();
    expect(k1.length).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Rotate key" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Rotate key" }).click();
    await expect(dialog).toBeHidden();
    const status = page.getByRole("region", { name: "Rotation" }).getByRole("status");
    await expect(status).toContainText("Rotated. New active key ");
    const k2 = /New active key (\S+); (\S+) is now verification only\./.exec(await status.innerText());
    expect(k2?.[2]).toBe(k1);
    const newKid = k2![1]!;
    expect(newKid).not.toBe(k1);
    await expect(table.getByRole("row").filter({ hasText: newKid })).toContainText("Active — signs new tokens");
    await expect(table.getByRole("row").filter({ hasText: k1 })).toContainText("Retiring — verification only");

    // Public JWKS straight from the BE (not through fe-admin): both kids, public members only.
    const keys = await jwks();
    expect(keys.map((k) => k.kid)).toEqual(expect.arrayContaining([newKid, k1]));
    for (const k of keys) for (const m of ["d", "p", "q", "dp", "dq", "qi"]) expect(k, `${k.kid} has no '${m}'`).not.toHaveProperty(m);

    // Context B right away: its ID token is signed with K2, unknown to the JWKS fe-admin cached
    // at A's sign-in moments ago => must be refetched at once (no 30 s cooldown).
    const pageB = await b.newPage();
    await pageB.goto(`${FE_ADMIN_URL}/keys`);
    await signInAsAdmin(pageB);
    await expect(pageB.getByTestId("viewer-email")).toBeVisible();
    await expect(pageB.getByRole("table", { name: "Signing keys" }).getByRole("row").filter({ hasText: newKid })).toContainText("Active");

    // Emergency: open, check the warning and the typed gate, cancel. Never sent.
    await page.getByRole("button", { name: "Emergency rotation…" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Refresh tokens and IdP sessions are not revoked");
    await expect(dialog.getByRole("alert")).toContainText("There is no rollback.");
    const confirm = dialog.getByRole("button", { name: "Rotate now" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Type EMERGENCY to confirm").fill("emergency");
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Type EMERGENCY to confirm").fill("EMERGENCY");
    await expect(confirm).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect((await jwks()).map((k) => k.kid)).toEqual(expect.arrayContaining([newKid, k1]));

    for (const p of [page, pageB]) {
      const url = new URL(p.url());
      expect(url.pathname).toBe("/keys");
      expect(url.search, "no kid / mode in the URL").toBe("");
      const text = await p.locator("body").innerText();
      for (const leak of ["eyJ", '"d":', "BEGIN"]) expect(text.includes(leak), `page text has no ${leak}`).toBe(false);
    }
  } finally {
    await a.close();
    await b.close();
  }
});
