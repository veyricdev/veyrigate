import { test, expect, type Page } from "@playwright/test";
import { FE_ADMIN_URL, ISSUER } from "../config/env";
import { signInAsAdmin } from "./support/fe-admin";

/**
 * Run 49 Task 4 (A6.5), run 86 (DEBT-393 pre-publish, D86.12): a NORMAL key rotation on the real
 * fe-admin. The E2E BE runs with `KEY_PREPUBLISH_SEC=20`: the new kid K2 is published at once as
 * pending (in the public JWKS, no private member) while K1 keeps signing, a second normal rotation
 * meanwhile gets the fixed 409 text, then K2 becomes active and K1 retiring. A fresh sign-in after
 * that (context B) proves the fe-admin callback accepts an ID token signed with K2 although its
 * JWKS was fetched before K2 existed (`cooldownDuration: 0`, run 49 Q-49.3, DEBT-349). The
 * emergency dialog is only opened, checked and cancelled: an emergency rotation is never sent here
 * (BE int + FE unit cover it).
 *
 * Never with `E2E_REUSE=1`: the reused BE may use the dev key dir (`be/keys`). The E2E stack keeps
 * its keys in `e2e/.keys` between runs (expired retiring keys are dropped by the next rotation;
 * nothing flushed), so an interrupted previous run may have left a pending key: wait it out first.
 */
test.skip(process.env.E2E_REUSE === "1", "rotation would hit the reused BE key dir");

interface Jwk {
  kid: string;
  [member: string]: unknown;
}

/** 20 s pre-publish + margin (clock skew, slow CI). */
const PREPUBLISH_WAIT_MS = 40_000;
const CONFLICT_TEXT =
  "A newer signing key is already published and does not sign yet. Wait until it activates, or use an emergency rotation.";
const PENDING_HINT =
  "A new key is already published and does not sign yet. Rotate again after it activates, or use an emergency rotation.";

const keyTable = (p: Page) => p.getByRole("table", { name: "Signing keys" });

/** Reload /keys until `check` holds (the page reads the list once per load). */
async function reloadUntil(p: Page, check: () => Promise<void>) {
  await expect(async () => {
    await p.reload();
    await expect(keyTable(p)).toBeVisible();
    await check();
  }).toPass({ timeout: PREPUBLISH_WAIT_MS, intervals: [2_000] });
}

test("fe-admin signing keys: normal rotation pre-publishes, 409 meanwhile, activation, JWKS, fresh sign-in on the new key, emergency dialog cancelled", async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
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
    const table = keyTable(page);
    await expect(table).toBeVisible();
    // An interrupted previous run may have left a pending key (e2e/.keys persists).
    await reloadUntil(page, () => expect(table.getByRole("row").filter({ hasText: "Pending —" })).toHaveCount(0, { timeout: 1_000 }));
    const activeRow = table.getByRole("row").filter({ hasText: "Active — signs new tokens" });
    await expect(activeRow).toHaveCount(1);
    const k1 = (await activeRow.getByRole("rowheader").innerText()).trim();
    expect(k1.length).toBeGreaterThan(0);

    // A second tab (same session) loaded before the rotation, its normal dialog already open: the race.
    const stale = await a.newPage();
    await stale.goto(`${FE_ADMIN_URL}/keys`);
    await expect(keyTable(stale).getByRole("row").filter({ hasText: k1 })).toContainText("Active");
    await stale.getByRole("button", { name: "Rotate key" }).click();
    const staleDialog = stale.getByRole("alertdialog");
    await expect(staleDialog).toContainText("starts signing after the pre-publish delay");

    await page.getByRole("button", { name: "Rotate key" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Rotate key" }).click();
    await expect(dialog).toBeHidden();
    const status = page.getByRole("region", { name: "Rotation" }).getByRole("status");
    await expect(status).toContainText("Rotated. New key ");
    const rotated = /New key (\S+) is published and signs from (\S+)\. (\S+) keeps signing until then, then is verification only\./.exec(
      await status.innerText(),
    );
    expect(rotated?.[3]).toBe(k1);
    const newKid = rotated![1]!;
    const activatesAt = rotated![2]!;
    expect(newKid).not.toBe(k1);
    expect(Number.isNaN(Date.parse(activatesAt))).toBe(false);
    await expect(table.getByRole("row").filter({ hasText: newKid })).toContainText(`Pending — published, signs from ${activatesAt}`);
    await expect(table.getByRole("row").filter({ hasText: k1 })).toContainText("Active — signs new tokens");
    await expect(page.getByRole("button", { name: "Rotate key" })).toBeDisabled();
    await expect(page.getByRole("region", { name: "Rotation" })).toContainText(PENDING_HINT);
    await expect(page.getByRole("button", { name: "Emergency rotation…" })).toBeEnabled();

    // Public JWKS straight from the BE (not through fe-admin): the pending key is already published.
    let keys = await jwks();
    expect(keys.map((k) => k.kid)).toEqual(expect.arrayContaining([newKid, k1]));
    for (const k of keys) for (const m of ["d", "p", "q", "dp", "dq", "qi"]) expect(k, `${k.kid} has no '${m}'`).not.toHaveProperty(m);

    // The stale tab confirms while K2 is pending: fixed 409 text in its dialog, then its list shows K2 pending.
    await staleDialog.getByRole("button", { name: "Rotate key" }).click();
    await expect(staleDialog.getByRole("alert")).toHaveText(CONFLICT_TEXT);
    await staleDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(staleDialog).toBeHidden();
    // Checked after Cancel: the modal alertdialog hides the rest of the page from the accessibility
    // tree. No reload here: the row comes from the re-read the 409 triggered (this tab loaded before
    // the rotation, so it never had K2).
    await expect(keyTable(stale).getByRole("row").filter({ hasText: newKid })).toContainText("Pending —");
    await stale.close();

    // After the pre-publish delay: K2 signs, K1 is verification only.
    await reloadUntil(page, () =>
      expect(table.getByRole("row").filter({ hasText: newKid })).toContainText("Active — signs new tokens", { timeout: 1_000 }),
    );
    await expect(table.getByRole("row").filter({ hasText: k1 })).toContainText("Retiring — verification only");
    await expect(page.getByRole("button", { name: "Rotate key" })).toBeEnabled();
    keys = await jwks();
    expect(keys.map((k) => k.kid)).toEqual(expect.arrayContaining([newKid, k1]));

    // Context B now: its ID token is signed with K2, unknown to the JWKS fe-admin cached at A's
    // sign-in (before the rotation) => must be refetched at once (no 30 s cooldown).
    const pageB = await b.newPage();
    await pageB.goto(`${FE_ADMIN_URL}/keys`);
    await signInAsAdmin(pageB);
    await expect(pageB.getByTestId("viewer-email")).toBeVisible();
    await expect(keyTable(pageB).getByRole("row").filter({ hasText: newKid })).toContainText("Active");

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
