import { test, expect, type Response } from "@playwright/test";
import { DEV_SEED_EMAIL, DEV_SEED_PASSWORD, FE_PORT } from "../config/env";

/** Decode a JWT payload (base64url) without verifying — the BE already signed/validated it. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

/**
 * X1 walking skeleton (plan §8): the full browser login flow through the BE OIDC endpoints ending
 * at the fe-sso-test claims panel.
 *
 * FE `/` → "Sign in" (`/authorize`) → BE `GET /login` → fill dev email/password → `POST /login`
 * → consent (`/authorize/consent` → Allow) if shown → `/callback` exchanges the code at `/token`
 * → back to FE `/` showing `data-testid="claims"`.
 *
 * Security asserts (fail-closed, token-exposure budget): capture the REAL `/token` response and
 * prove none of `access_token`/`refresh_token`/`id_token` ever appears in the DOM, the URL, or
 * Web Storage; and that `claim-sub` equals the `sub` decoded from the id_token (a 24-hex id).
 */
test("login → /authorize → /login → /token → claims (tokens never exposed)", async ({ page }) => {
  // Capture the authorization-code `/token` exchange (not the discovery/jwks calls).
  const tokenResponsePromise: Promise<Response> = page.waitForResponse(
    (res) =>
      res.url().endsWith("/token") &&
      res.request().method() === "POST" &&
      res.status() === 200,
  );

  await page.goto("/");
  // FE "Sign in" redirects the whole page to the BE `/authorize`, which (no session) 302s to the
  // BE login page. Wait for that navigation to fully settle before touching the form so we never
  // submit from a transitional document (which Chromium rejects via CSP `form-action 'self'`).
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/login/, { waitUntil: "load" });

  // BE login page (login.eta): labelled Email/Password inputs inside `form[action="/login"]`.
  const loginForm = page.locator('form[action="/login"]');
  await loginForm.getByLabel("Email").fill(DEV_SEED_EMAIL);
  await loginForm.getByLabel("Password").fill(DEV_SEED_PASSWORD);

  // Submit the login form and wait for the resulting top-level navigation to settle. After login
  // the BE resumes `/authorize`, which EITHER renders the consent screen (`consent.eta`, at
  // `GET /authorize?request_id=...`) when consent is required, OR 302s straight back to the FE
  // when consent is already on record. Wait for whichever landing settles (no fixed sleep).
  const consentForm = page.locator('form[action="/authorize/consent"]');
  const claimsPanel = page.getByTestId("claims");
  await Promise.all([
    page.waitForURL(
      (url) => /\/authorize\b/.test(url.pathname) || url.port === String(FE_PORT),
      { waitUntil: "load" },
    ),
    loginForm.getByRole("button", { name: "Sign in" }).click(),
  ]);

  // If the consent screen is showing, approve it; that 302s to `/callback` → the FE.
  if (await consentForm.isVisible()) {
    await Promise.all([
      page.waitForURL(`http://localhost:${FE_PORT}/`, { waitUntil: "load" }),
      consentForm.getByRole("button", { name: "Allow" }).click(),
    ]);
  } else {
    await page.waitForURL(`http://localhost:${FE_PORT}/`, { waitUntil: "load" });
  }

  // Land back on the FE home with the claims panel rendered.
  await expect(claimsPanel).toBeVisible();

  const tokenResponse = await tokenResponsePromise;
  const tokenJson = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token: string;
  };
  expect(tokenJson.access_token).toBeTruthy();
  expect(tokenJson.id_token).toBeTruthy();

  // claim-sub matches the id_token `sub`, which is a 24-hex Mongo id.
  const sub = decodeJwtPayload(tokenJson.id_token).sub as string;
  expect(sub).toMatch(/^[a-f0-9]{24}$/);
  await expect(page.getByTestId("claim-sub")).toHaveText(sub);

  // Exposure budget: no raw token appears in the DOM or the URL.
  const content = await page.content();
  const url = page.url();
  const secrets = [tokenJson.access_token, tokenJson.id_token, tokenJson.refresh_token].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  for (const secret of secrets) {
    expect(content).not.toContain(secret);
    expect(url).not.toContain(secret);
  }

  // Exposure budget: nothing persisted to Web Storage (tokens live in-memory only, F7/OPEN-1).
  const storageDump = await page.evaluate(() => {
    const dump = (s: Storage) => {
      const out: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k) out.push(`${k}=${s.getItem(k) ?? ""}`);
      }
      return out.join("\n");
    };
    return `${dump(localStorage)}\n${dump(sessionStorage)}`;
  });
  for (const secret of secrets) {
    expect(storageDump).not.toContain(secret);
  }

  // The post-exchange URL is clean: no leftover `code`/`state` on the FE origin.
  expect(url).not.toContain("code=");
  expect(url).not.toContain("state=");
});
