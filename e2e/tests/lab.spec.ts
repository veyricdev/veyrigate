import { test, expect } from "@playwright/test";
import { BE_PORT } from "../config/env";
import { captureTokenSecrets, expectNoSecretsExposed, signInAtIdp } from "./support/oidc";

/**
 * Smoke of the dev-only `/lab` (run 25 T5, Task 4). Each test runs in a fresh browser context (no
 * IdP cookie). The refresh replay revokes the token family, so it is last and logs in on its own.
 */

test("lab /authorize: redirect_uri mismatch ⇒ IdP 400 error page, no redirect back (INV-4)", async ({
  page,
}) => {
  await page.goto("/lab");
  const [nav] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.request().isNavigationRequest() && new URL(res.url()).pathname === "/authorize",
    ),
    page.getByTestId("lab-run-redirect-uri-mismatch").click(),
  ]);
  expect(nav.status()).toBe(400);
  await page.waitForLoadState("load");
  const url = new URL(page.url());
  expect(url.port).toBe(String(BE_PORT));
  expect(url.pathname).toBe("/authorize");
});

// Scenarios the IdP answers by redirecting `error=` back (no session needed — clean context).
for (const id of [
  "pkce-plain",
  "no-code-challenge",
  "resource-unknown",
  "resource-relative",
  "prompt-none-max-age-0",
  "prompt-none-no-session",
]) {
  test(`lab /authorize: ${id} ⇒ error redirect scored PASS`, async ({ page }) => {
    const capture = captureTokenSecrets(page);
    await page.goto("/lab");
    await page.getByTestId(`lab-run-${id}`).click();
    const verdict = page.getByTestId(`lab-result-${id}`);
    await expect(verdict).toContainText("PASS", { timeout: 15_000 });
    await expect(verdict).toContainText("iss ok");
    // A lab callback is never exchanged at `/token`.
    expect((await capture.collect()).exchanges).toBe(0);
  });
}

test("lab /authorize: no-nonce ⇒ IdP accepts (code), lab never exchanges it", async ({ page }) => {
  const capture = captureTokenSecrets(page);
  await page.goto("/lab");
  await page.getByTestId("lab-run-no-nonce").click();
  const verdict = page.getByTestId("lab-result-no-nonce");
  await signInAtIdp(page, verdict);
  await expect(verdict).toContainText("PASS");
  await expect(verdict).toContainText("iss ok");
  expect((await capture.collect()).exchanges).toBe(0);
});

test("lab state tamper: forged state rejected by the real callback, no /token call", async ({
  page,
}) => {
  const capture = captureTokenSecrets(page);
  await page.goto("/lab");
  await page.getByTestId("lab-run-state-tamper").click();
  const verdict = page.getByTestId("lab-result-state-tamper");
  await signInAtIdp(page, verdict);
  await expect(verdict).toContainText("PASS");
  expect((await capture.collect()).exchanges).toBe(0);
});

// Last: it revokes the whole refresh-token family (the session is lost — expected, plan §11).
test("lab refresh replay: rotate, replay old RT ⇒ invalid_grant, descendant ⇒ invalid_grant", async ({
  page,
}) => {
  const capture = captureTokenSecrets(page);
  await page.goto("/lab");
  await page.getByTestId("lab-replay-signin").getByRole("link", { name: "Sign in" }).click();
  const run = page.getByTestId("lab-replay-run");
  await signInAtIdp(page, run);

  await run.click();
  for (const step of [1, 2, 3]) {
    await expect(page.getByTestId(`lab-replay-step-${step}`)).toContainText("PASS");
  }
  await expect(page.getByTestId("lab-replay-note")).toBeVisible();

  const { secrets, exchanges, unreadable } = await capture.collect();
  // login exchange + the one successful rotation (steps 2/3 are 400 invalid_grant).
  expect(exchanges).toBe(2);
  expect(unreadable).toBe(0);
  await expectNoSecretsExposed(page, secrets);
});
