import { test, expect } from "@playwright/test";
import { FE_PORT } from "../config/env";
import {
  approveConsentUntil,
  captureTokenSecrets,
  decodeJwtPayload,
  expectNoSecretsExposed,
  signInAtIdp,
} from "./support/oidc";

/**
 * T4 E2E (run 25 Task 4, plan §258): guarded `/profile` → `/api-test` checks A/B/C.
 *  - A `/demo/me` with the session access token (aud=demo) → 200.
 *  - B wrong-aud probe: revoke → `/authorize` for `other` → exchange → `/demo/me` → 401 (INV-8),
 *    then the main session is restored (`prompt=none`) — same `sub` afterwards.
 *  - C `/userinfo` → 200.
 * Tokens of EVERY `/token` exchange (login, probe, restore) are captured to prove none leaks.
 */
test("/api-test A/B/C: demo 200, wrong-aud probe 401, userinfo 200 (tokens never exposed)", async ({
  page,
}) => {
  const capture = captureTokenSecrets(page);

  // Guarded route ⇒ `/login?returnTo=/profile` ⇒ IdP ⇒ back on `/profile`.
  await page.goto("/profile");
  const profileSub = page.getByTestId("profile-sub");
  await signInAtIdp(page, profileSub);
  const sub = (await profileSub.textContent()) ?? "";
  expect(sub).toMatch(/^[a-f0-9]{24}$/);

  // In-app navigation keeps the in-memory session (DEBT-101).
  await page.getByRole("link", { name: "Home" }).click();
  await page.getByRole("link", { name: "API test" }).click();
  await expect(page.getByTestId("api-test-actions")).toBeVisible();

  // A — correct aud.
  await page.getByTestId("btn-demo").click();
  await expect(page.getByTestId("result-demo-verdict")).toContainText("PASS");
  await expect(page.getByTestId("result-demo-verdict")).toContainText("HTTP 200");
  await expect(page.getByTestId("result-demo-sub")).toHaveText(`sub: ${sub}`);

  // C — userinfo.
  await page.getByTestId("btn-userinfo").click();
  await expect(page.getByTestId("result-userinfo-verdict")).toContainText("PASS");
  await expect(page.getByTestId("result-userinfo-verdict")).toContainText("HTTP 200");
  await expect(page.getByTestId("result-userinfo-sub")).toHaveText(`sub: ${sub}`);

  // B — redirect chain (consent for `other` may or may not be shown), lands back on `/api-test`.
  const probeVerdict = page.getByTestId("result-probe-verdict");
  await page.getByTestId("btn-probe").click();
  await approveConsentUntil(page, probeVerdict);
  await page.waitForURL(
    (url) => url.port === String(FE_PORT) && url.pathname === "/api-test",
    { waitUntil: "load" },
  );
  await expect(probeVerdict).toContainText("PASS");
  await expect(probeVerdict).toContainText("HTTP 401");

  // The restored session works: A again with the new access token, same user.
  await page.getByTestId("btn-demo").click();
  await expect(page.getByTestId("result-demo-verdict")).toContainText("HTTP 200");
  await expect(page.getByTestId("result-demo-sub")).toHaveText(`sub: ${sub}`);

  // `sub` on `/profile` is unchanged after the probe + restore.
  await page.getByRole("link", { name: "Home" }).click();
  await page.getByRole("link", { name: "Profile" }).click();
  await expect(page.getByTestId("profile-sub")).toHaveText(sub);

  const { secrets, idTokens, exchanges, unreadable } = await capture.collect();
  // login + probe exchange + silent restore (+ a fallback interactive login, if any).
  expect(exchanges).toBeGreaterThanOrEqual(3);
  expect(unreadable).toBe(0);
  for (const idToken of idTokens) expect(decodeJwtPayload(idToken).sub).toBe(sub);

  await expectNoSecretsExposed(page, secrets);
  await page.getByRole("link", { name: "Home" }).click();
  await page.getByRole("link", { name: "API test" }).click();
  await expectNoSecretsExposed(page, secrets);
  const url = new URL(page.url());
  expect(url.searchParams.has("code")).toBe(false);
  expect(url.searchParams.has("state")).toBe(false);
});
