import { test, expect, request, type Browser, type Page } from "@playwright/test";
import { BE_PORT, FE_PORT, ISSUER } from "../config/env";
import { expectNoSecretsExposed, signInAtIdp } from "./support/oidc";

/**
 * Logout local vs global (run 39 Task 1, X2). Two browser contexts A and B (separate cookie jars)
 * sign the SAME dev user into fe-sso-test. Tokens are captured from the real `/token` response and
 * kept in variables only; every check on them is a status / error-code boolean (never echoed).
 * Refresh rotation + reuse-detect are covered by `lab.spec.ts › lab refresh replay`.
 */

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const isIdp = (url: URL) => url.port === String(BE_PORT);

/** New context → fe-sso-test `/` → Sign in → IdP login (+ consent if asked) → claims. */
async function signedInPage(browser: Browser): Promise<{ page: Page; tokens: Tokens }> {
  const page = await (await browser.newContext()).newPage();
  const tokenRes = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return isIdp(url) && url.pathname === "/token" && res.request().method() === "POST";
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  await signInAtIdp(page, page.getByTestId("claims"));
  const res = await tokenRes;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  const { access_token: at, refresh_token: rt } = body;
  // typeof, not String(): a missing token must fail here, not become "undefined" (DEBT-246).
  expect(typeof at === "string" && at.length > 0 && typeof rt === "string" && rt.length > 0, "tokens issued").toBe(
    true,
  );
  const tokens = { accessToken: at as string, refreshToken: rt as string };
  await expectNoSecretsExposed(page, [tokens.accessToken, tokens.refreshToken]);
  return { page, tokens };
}

/** FE "Sign out" → IdP logout page → the given button → back on the FE signed-out view. */
async function signOut(page: Page, button: "Sign out" | "Sign out everywhere"): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/logout", { waitUntil: "load" });
  await page.locator('form[action="/logout"]').getByRole("button", { name: button, exact: true }).click();
  await page.waitForURL((url) => url.port === String(FE_PORT) && url.pathname === "/");
  await expect(page.getByTestId("signed-out")).toBeVisible();
}

/** `/userinfo` status for an access token (cookie-less request context, token only in the header). */
async function userinfoStatus(accessToken: string): Promise<number> {
  const api = await request.newContext();
  try {
    const res = await api.get(`${ISSUER}/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.status();
  } finally {
    await api.dispose();
  }
}

test("logout local: A signs out, A's token is dead, B keeps its token and IdP session", async ({
  browser,
}) => {
  const a = await signedInPage(browser);
  const b = await signedInPage(browser);

  await signOut(a.page, "Sign out");

  expect(await userinfoStatus(a.tokens.accessToken)).toBe(401);
  expect(await userinfoStatus(b.tokens.accessToken)).toBe(200);

  // B's IdP session survived: a fresh Sign in returns to the claims without the login form.
  const idpLogin: string[] = [];
  b.page.on("request", (req) => {
    const url = new URL(req.url());
    if (req.isNavigationRequest() && isIdp(url) && url.pathname === "/login") idpLogin.push("x");
  });
  await b.page.goto("/");
  await b.page.getByRole("button", { name: "Sign in" }).click();
  await expect(b.page.getByTestId("claims")).toBeVisible();
  expect(idpLogin.length).toBe(0);

  await a.page.context().close();
  await b.page.context().close();
});

test("logout global: B signs out everywhere, both tokens dead, A's refresh_token invalid_grant", async ({
  browser,
}) => {
  const a = await signedInPage(browser);
  const b = await signedInPage(browser);

  await signOut(b.page, "Sign out everywhere");

  expect(await userinfoStatus(a.tokens.accessToken)).toBe(401);
  expect(await userinfoStatus(b.tokens.accessToken)).toBe(401);

  const api = await request.newContext();
  try {
    const res = await api.post(`${ISSUER}/token`, {
      form: {
        grant_type: "refresh_token",
        refresh_token: a.tokens.refreshToken,
        client_id: "fe-sso-test",
      },
    });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("invalid_grant");
  } finally {
    await api.dispose();
  }

  // A's IdP session is gone too: Sign in lands on the IdP login form.
  await a.page.goto("/");
  await a.page.getByRole("button", { name: "Sign in" }).click();
  await a.page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
  await expect(a.page.locator('form[action="/login"]')).toBeVisible();

  await a.page.context().close();
  await b.page.context().close();
});
