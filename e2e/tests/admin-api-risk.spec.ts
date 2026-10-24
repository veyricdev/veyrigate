import { test, expect, type Page, type Request } from "@playwright/test";
import { ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, BE_PORT, FE_ADMIN_URL } from "../config/env";

/**
 * Tester (run 43 A5): the admin server functions over the real fe-admin dev server + real BE.
 *  - called from the app's own page they reach the BE (getClient ok, hostile id => not_found);
 *  - the SAME request replayed without a same-origin signal (no header, foreign Origin/Referer,
 *    Sec-Fetch-Site cross-site/same-site/none) is refused by the CSRF middleware (403);
 *  - no response carries a JWT, a secret hash or a raw BE body.
 * No DB write: the only mutation targets a client id that does not exist (BE answers 404).
 */

const isIdp = (url: URL) => url.port === String(BE_PORT);

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto(`${FE_ADMIN_URL}/`);
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
  const form = page.locator('form[action="/login"]');
  await form.getByLabel("Email").fill(ADMIN_SEED_EMAIL);
  await form.getByLabel("Password").fill(ADMIN_SEED_PASSWORD);
  await form.getByRole("button", { name: "Sign in" }).click();
  const consent = page.locator('form[action="/authorize/consent"]');
  const email = page.getByTestId("viewer-email");
  for (let i = 0; i < 3; i++) {
    await expect(consent.or(email).first()).toBeVisible({ timeout: 30_000 });
    if (await email.isVisible()) break;
    await consent.getByRole("button", { name: "Allow" }).click();
    await consent.waitFor({ state: "detached" });
  }
  await expect(page.getByTestId("viewer-email")).toHaveText(ADMIN_SEED_EMAIL);
}

type Fn = "getClient" | "updateClient" | "listClients";

/** Calls a server function from the app page (real client RPC, browser same-origin headers). */
async function callFromPage(page: Page, fn: Fn, data: unknown): Promise<{ result: unknown; request: Request; body: string; status: number }> {
  const reqP = page.waitForRequest((r) => new URL(r.url()).pathname.startsWith("/_serverFn"));
  const result = await page.evaluate(
    async ([name, input, modulePath]) => {
      // Vite dev module of the app (served by fe-admin); a variable path keeps tsc from resolving it.
      const mod = (await import(/* @vite-ignore */ modulePath)) as Record<
        string,
        (o: { data: unknown }) => Promise<unknown>
      >;
      try {
        return { value: await mod[name]!({ data: input }) };
      } catch (e) {
        return { thrown: String((e as Error)?.message ?? e) };
      }
    },
    [fn, data, "/src/features/admin-api/clients.ts"] as const,
  );
  const request = await reqP;
  const res = await request.response();
  return { result, request, body: res ? await res.text() : "", status: res?.status() ?? 0 };
}

const LEAK = /eyJ|secretHash|clientSecret|Bearer|WWW-Authenticate|invalid_token/;

test("admin server functions: same-origin works, cross-site replay refused, nothing leaks", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAsAdmin(page);
  await page.goto(`${FE_ADMIN_URL}/`, { waitUntil: "networkidle" });

  // getClient on the real fe-admin client: allowlisted fields only.
  const ok = await callFromPage(page, "getClient", "fe-admin");
  expect(ok.status).toBe(200);
  expect(ok.result).toMatchObject({ value: { ok: true, data: { clientId: "fe-admin" } } });
  expect(LEAK.test(ok.body), "no token/secret/raw error in the getClient response").toBe(false);

  // Hostile ids that pass the schema: one encoded segment at the BE => not_found (never another route).
  for (const id of ["%2F..%2Fadmin%2Fusers", "..%5c..", "ứng-dụng-🚀", "．．"]) {
    const r = await callFromPage(page, "getClient", id);
    expect(r.result, id).toEqual({ value: { ok: false, error: { code: "not_found", message: "Not found." } } });
  }

  // Ids the schema refuses never reach the BE: a generic error (no validator detail echoed).
  const bad = await callFromPage(page, "getClient", "../x");
  expect(bad.result).toHaveProperty("thrown");
  expect(bad.body.includes("../x")).toBe(false);

  // Mutation on a client that does not exist (fresh sign-in => recent auth OK; no DB write).
  const missing = `e2e-missing-${Date.now()}`;
  const upd = await callFromPage(page, "updateClient", { clientId: missing, patch: { disabled: true } });
  expect(upd.result).toEqual({ value: { ok: false, error: { code: "not_found", message: "Not found." } } });
  expect(LEAK.test(upd.body)).toBe(false);

  // Patch with an unknown field / wrong type: refused before the BE (generic error).
  for (const patch of [{ tenantId: "t2" }, { disabled: "true" }, { grantTypes: ["client_credentials"] }]) {
    const r = await callFromPage(page, "updateClient", { clientId: missing, patch });
    expect(r.result, JSON.stringify(patch)).toHaveProperty("thrown");
  }

  // CSRF: replay the exact updateClient / getClient requests with the session cookie but
  // without a same-origin signal.
  const replays: { name: string; set: Record<string, string> }[] = [
    { name: "no Origin / Referer / Sec-Fetch-Site", set: {} },
    { name: "foreign Origin", set: { origin: "http://evil.example" } },
    { name: "null Origin", set: { origin: "null" } },
    { name: "foreign Referer", set: { referer: "http://evil.example/x" } },
    { name: "look-alike Referer", set: { referer: `${FE_ADMIN_URL}.evil.example/` } },
    { name: "Sec-Fetch-Site cross-site", set: { "sec-fetch-site": "cross-site", origin: FE_ADMIN_URL } },
    { name: "Sec-Fetch-Site same-site", set: { "sec-fetch-site": "same-site" } },
    // Run 51 (A7): a user-initiated navigation signal is not same-origin either.
    { name: "Sec-Fetch-Site none", set: { "sec-fetch-site": "none" } },
  ];
  for (const captured of [upd.request, ok.request]) {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(await captured.allHeaders())) {
      if (!/^(origin|referer|sec-fetch-|cookie|host|content-length)/i.test(k)) base[k] = v;
    }
    const send = (set: Record<string, string>) =>
      context.request.fetch(captured.url(), {
        method: captured.method(),
        headers: { ...base, ...set },
        data: captured.postData() ?? undefined,
        maxRedirects: 0,
      });
    for (const r of replays) {
      const res = await send(r.set);
      expect(res.status(), `${captured.method()} ${r.name}`).toBe(403);
      expect(LEAK.test(await res.text())).toBe(false);
    }
    // Positive control: same request with a same-origin Origin goes through the middleware.
    const control = await send({ origin: FE_ADMIN_URL });
    expect(control.status(), `${captured.method()} same-origin control`).toBe(200);
  }

  // Signed out (cookie dropped): the server function answers unauthenticated without the BE.
  await context.clearCookies();
  const anon = await callFromPage(page, "getClient", "fe-admin");
  expect(anon.result).toMatchObject({ value: { ok: false, error: { code: "unauthenticated" } } });

  await context.close();
});
