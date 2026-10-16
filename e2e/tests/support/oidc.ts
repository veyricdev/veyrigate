import { expect, type Locator, type Page } from "@playwright/test";
import { BE_PORT, DEV_SEED_EMAIL, DEV_SEED_PASSWORD } from "../../config/env";

/**
 * Shared E2E helpers (run 25 Task 4). URL waits use pathname/port predicates only — never a regex
 * over the full URL — so a failure message can never print a callback `code`/`state` (DEBT-108).
 */

/** Decode a JWT payload (base64url) without verifying — the BE already signed/validated it. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

const isIdp = (url: URL) => url.port === String(BE_PORT);

/**
 * Collect the raw tokens of EVERY `POST /token` 200 on the IdP (login, probe exchange, silent
 * restore, refresh) — F7(b). Bodies are read as they arrive; `collect()` awaits them all.
 */
export function captureTokenSecrets(page: Page) {
  const pending: Promise<void>[] = [];
  const secrets: string[] = [];
  const idTokens: string[] = [];
  let unreadable = 0;
  page.on("response", (res) => {
    const url = new URL(res.url());
    if (!isIdp(url) || url.pathname !== "/token") return;
    if (res.request().method() !== "POST" || res.status() !== 200) return;
    pending.push(
      res.json().then(
        (body: Record<string, unknown>) => {
          for (const k of ["access_token", "refresh_token", "id_token"]) {
            const v = body[k];
            if (typeof v === "string" && v.length > 0) secrets.push(v);
          }
          if (typeof body.id_token === "string") idTokens.push(body.id_token);
        },
        () => {
          unreadable++;
        },
      ),
    );
  });
  return {
    async collect() {
      await Promise.all(pending);
      return { secrets, idTokens, exchanges: pending.length, unreadable };
    },
  };
}

/**
 * Drive the IdP until `done` is visible: approve any consent screen on the way (the `other`
 * resource may or may not already have consent on record). Bounded to avoid an endless loop.
 */
export async function approveConsentUntil(page: Page, done: Locator): Promise<void> {
  const consentForm = page.locator('form[action="/authorize/consent"]');
  for (let i = 0; i < 4; i++) {
    await expect(consentForm.or(done).first()).toBeVisible({ timeout: 30_000 });
    if (await done.isVisible()) return;
    await consentForm.getByRole("button", { name: "Allow" }).click();
    await consentForm.waitFor({ state: "detached" });
  }
  await expect(done).toBeVisible();
}

/** On the IdP login page (reached by the FE redirect), sign in, approve consent, wait for `done`. */
export async function signInAtIdp(page: Page, done: Locator): Promise<void> {
  // Wait for the IdP login document to fully load (submitting from a transitional document is
  // rejected by CSP `form-action 'self'`). The FE also has `/login`, hence the port check.
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
  const loginForm = page.locator('form[action="/login"]');
  await loginForm.getByLabel("Email").fill(DEV_SEED_EMAIL);
  await loginForm.getByLabel("Password").fill(DEV_SEED_PASSWORD);
  await loginForm.getByRole("button", { name: "Sign in" }).click();
  await approveConsentUntil(page, done);
}

/** Exposure budget: no raw token in the DOM, the URL, or Web Storage. */
export async function expectNoSecretsExposed(page: Page, secrets: readonly string[]): Promise<void> {
  const content = await page.content();
  const url = page.url();
  const storage = await page.evaluate(() => {
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
  // Boolean asserts: a failure must not echo the secret itself into the report/log.
  for (const secret of secrets) {
    expect(content.includes(secret), "token found in DOM").toBe(false);
    expect(url.includes(secret), "token found in URL").toBe(false);
    expect(storage.includes(secret), "token found in Web Storage").toBe(false);
  }
}
