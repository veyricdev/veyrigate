import { test, expect, type Browser, type Page } from "@playwright/test";
import { BE_PORT, DEV_SEED_EMAIL, DEV_SEED_PASSWORD, FE_PORT } from "../config/env";
import {
  approveConsentUntil,
  captureTokenSecrets,
  decodeJwtPayload,
  expectNoSecretsExposed,
  signInAtIdp,
} from "./support/oidc";

/**
 * X4 (run 33, F21): federation end to end against the in-process mock Google of
 * `be/test/e2e/e2e-main.ts` (127.0.0.1, random port). No real provider is ever contacted: every
 * request of every page must stay on localhost / 127.0.0.1. Idempotent: random provider subjects
 * and emails per run, nothing dropped. URL waits use host/port/pathname predicates only, and no
 * URL is ever printed (callback `code`/`state` never reach the output, DEBT-108).
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const isIdp = (url: URL) => url.port === String(BE_PORT);
const isMockGoogle = (url: URL) =>
  url.hostname === "127.0.0.1" && url.port !== String(BE_PORT) && url.port !== String(FE_PORT);
const rand = () => Math.random().toString(36).slice(2, 10);

/** Record the HOST of any request leaving localhost (never the URL). */
function guardHosts(page: Page): string[] {
  const foreign: string[] = [];
  page.on("request", (req) => {
    const host = new URL(req.url()).hostname;
    if (!LOCAL_HOSTS.has(host)) foreign.push(host);
  });
  return foreign;
}

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page, foreign: guardHosts(page) };
}

/** FE "Sign in" -> IdP /login -> "Sign in with Google" -> mock consent form filled (not submitted). */
async function openMockGoogle(page: Page, identity: { sub: string; email: string }) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await page.waitForURL((url) => isMockGoogle(url) && url.pathname === "/authorize", {
    waitUntil: "load",
  });
  await page.getByLabel("Subject").fill(identity.sub);
  await page.getByLabel("Email", { exact: true }).fill(identity.email);
}

const continueAtMock = (page: Page) => page.getByRole("button", { name: "Continue" }).click();

/** Password login of the seeded dev user in its own context: its local `sub`. */
async function devUserSub(browser: Browser): Promise<string> {
  const { context, page } = await freshPage(browser);
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  const claimSub = page.getByTestId("claim-sub");
  await signInAtIdp(page, claimSub);
  const sub = (await claimSub.textContent()) ?? "";
  await context.close();
  expect(sub).toMatch(/^[a-f0-9]{24}$/);
  return sub;
}

test("federation: new Google user => claims of a NEW local account (no real provider)", async ({
  browser,
}) => {
  const devSub = await devUserSub(browser);
  const { context, page, foreign } = await freshPage(browser);
  const capture = captureTokenSecrets(page);

  await openMockGoogle(page, { sub: `e2e-g-${rand()}`, email: `e2e-fed-${rand()}@example.com` });
  await continueAtMock(page);
  const claimSub = page.getByTestId("claim-sub");
  await approveConsentUntil(page, claimSub);

  const sub = (await claimSub.textContent()) ?? "";
  expect(sub).toMatch(/^[a-f0-9]{24}$/);
  expect(sub).not.toBe(devSub);
  const { secrets, idTokens } = await capture.collect();
  expect(decodeJwtPayload(idTokens.at(-1)!).sub).toBe(sub);
  expect(decodeJwtPayload(idTokens.at(-1)!).amr).toEqual(["fed"]);
  await expectNoSecretsExposed(page, secrets);
  expect(foreign).toEqual([]);
  await context.close();
});

test("federation: verified email of an existing account => must sign in to it => linked; next time straight in", async ({
  browser,
}) => {
  const devSub = await devUserSub(browser);
  const providerSub = `e2e-link-${rand()}`;

  const { context, page, foreign } = await freshPage(browser);
  const capture = captureTokenSecrets(page);
  await openMockGoogle(page, { sub: providerSub, email: DEV_SEED_EMAIL });
  await continueAtMock(page);

  // INV-22: no auto-link — the IdP asks for the password of THAT account (email not editable).
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/auth/link", { waitUntil: "load" });
  const linkForm = page.locator('form[action="/auth/link"]');
  await expect(page.getByText(DEV_SEED_EMAIL)).toBeVisible();
  await expect(linkForm.locator('input[name="email"]')).toHaveCount(0);
  await linkForm.getByLabel("Password").fill(DEV_SEED_PASSWORD);
  await linkForm.getByRole("button", { name: "Link and sign in" }).click();

  const claimSub = page.getByTestId("claim-sub");
  await approveConsentUntil(page, claimSub);
  await expect(claimSub).toHaveText(devSub);
  const first = await capture.collect();
  await expectNoSecretsExposed(page, first.secrets);
  expect(foreign).toEqual([]);
  await context.close();

  // Signed out (fresh browser, no IdP session): the same Google identity goes straight in.
  const again = await freshPage(browser);
  const capture2 = captureTokenSecrets(again.page);
  await openMockGoogle(again.page, { sub: providerSub, email: DEV_SEED_EMAIL });
  await continueAtMock(again.page);
  const claimSub2 = again.page.getByTestId("claim-sub");
  await approveConsentUntil(again.page, claimSub2);
  await expect(claimSub2).toHaveText(devSub);
  const { secrets, idTokens } = await capture2.collect();
  expect(decodeJwtPayload(idTokens.at(-1)!).amr).toEqual(["fed"]);
  await expectNoSecretsExposed(again.page, secrets);
  expect(again.foreign).toEqual([]);
  await again.context.close();
});

test("federation: tampered state and a replayed callback => first-party error page, never the RP", async ({
  browser,
}) => {
  const { context, page, foreign } = await freshPage(browser);

  // (a) state modified at the provider.
  await openMockGoogle(page, { sub: `e2e-st-${rand()}`, email: `e2e-st-${rand()}@example.com` });
  await page.evaluate(() => {
    const state = document.querySelector<HTMLInputElement>('input[name="state"]')!;
    state.value = `${state.value}tampered`;
  });
  await continueAtMock(page);
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/auth/google/callback", {
    waitUntil: "load",
  });
  await expect(page.getByRole("heading", { name: "Sign-in failed" })).toBeVisible();
  await expect(page.getByText("This sign-in attempt is invalid or has expired.")).toBeVisible();

  // (b) a successful leg, then its callback URL replayed (never printed).
  let callbackUrl = "";
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (isIdp(url) && url.pathname === "/auth/google/callback") callbackUrl = req.url();
  });
  await openMockGoogle(page, { sub: `e2e-rp-${rand()}`, email: `e2e-rp-${rand()}@example.com` });
  await continueAtMock(page);
  const claimSub = page.getByTestId("claim-sub");
  await approveConsentUntil(page, claimSub);
  expect(callbackUrl.length > 0, "callback captured").toBe(true);

  const replay = await page.goto(callbackUrl);
  expect(replay?.status()).toBe(400);
  expect(isIdp(new URL(page.url())), "replay stays on the IdP").toBe(true);
  await expect(page.getByText("This sign-in attempt is invalid or has expired.")).toBeVisible();
  expect(foreign).toEqual([]);
  await context.close();
});

test("federation: wrong password on the link page => generic failure, no claims, nothing linked", async ({
  browser,
}) => {
  const { context, page, foreign } = await freshPage(browser);
  await openMockGoogle(page, { sub: `e2e-bad-${rand()}`, email: DEV_SEED_EMAIL });
  await continueAtMock(page);
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/auth/link", { waitUntil: "load" });
  const linkForm = page.locator('form[action="/auth/link"]');
  await linkForm.getByLabel("Password").fill(`not-${DEV_SEED_PASSWORD}`);
  await linkForm.getByRole("button", { name: "Link and sign in" }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/auth/link", { waitUntil: "load" });
  await expect(
    page.getByText("The account could not be linked. Please sign in again."),
  ).toBeVisible();
  await expect(page.getByTestId("claims")).toHaveCount(0);
  expect(foreign).toEqual([]);
  await context.close();
});
