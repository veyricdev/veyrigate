import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { DEV_SEED_EMAIL, DEV_SEED_PASSWORD, E2E_USER_EMAIL, E2E_USER_PASSWORD } from "../config/env";
import { X3_IDP_HOST, X3_ISSUER, X3_RPS, type X3Label, type X3Rp } from "./env";

/**
 * X3 cookie topology × browser matrix (run 73, plan X3, spec §9.6). Each case runs on the RP that
 * is same-site (`app.alpha`) and cross-site (`app.beta`) with the IdP (`idp.alpha`). "Was the
 * session cookie sent?" is measured from the browser's own request headers (navigations, form POST)
 * or, for the credentialed fetch, by the X3 proxy's `/__x3_echo` on the IdP host — cookie NAMES
 * only, never a value. Results go to `test-results/x3-matrix.json` (names/outcomes only).
 *
 * WebKit on Windows does not enforce `SameSite` (tech-lead probe, DEBT-506), so the "not sent
 * cross-site" asserts are Chromium/Firefox only; WebKit cells are recorded as measured.
 */

const SESSION = "__Host-idp_session";
const LEGACY = "idp_session";

interface Cell {
  case: string;
  topology: string;
  outcome?: string;
  cookieNames?: string[];
  /** `sameSite` as the browser stored the session cookie (server always sends `Lax`). */
  storedSameSite?: string;
}
const cells: (Cell & { browser: string; status: string })[] = [];
let current: Cell | null = null;

test.afterEach(async ({}, testInfo) => {
  if (!current) return;
  cells.push({ ...current, browser: testInfo.project.name, status: testInfo.status ?? "unknown" });
  current = null;
});

test.afterAll(async ({ browser }, testInfo) => {
  const file = resolve(testInfo.project.outputDir, "x3-matrix.json");
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // first project of this run (Playwright empties test-results/ at start)
  }
  all[testInfo.project.name] = { version: browser.version(), date: new Date().toISOString().slice(0, 10), cells };
  writeFileSync(file, JSON.stringify(all, null, 2));
});

function cell(name: string, topology: string): Cell {
  current = { case: name, topology };
  return current;
}

/** Cookie NAMES the browser attached to IdP requests (method + path + names, never values). */
function trackIdp(page: Page) {
  const pending: Promise<{ method: string; path: string; auth: boolean; names: string[] }>[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.hostname !== X3_IDP_HOST) return;
    pending.push(
      req.allHeaders().then((h) => ({
        method: req.method(),
        path: url.pathname,
        auth: "authorization" in h,
        names: (h.cookie ?? "")
          .split(";")
          .map((c) => c.trim().split("=")[0])
          .filter(Boolean)
          .sort(),
      })),
    );
  });
  return {
    async find(method: string, path: string, opts: { auth?: boolean } = {}) {
      const all = await Promise.all(pending);
      return all.filter(
        (r) => r.method === method && r.path === path && (opts.auth === undefined || r.auth === opts.auth),
      );
    },
  };
}

/** Chromium/Firefox enforce SameSite; WebKit-Windows does not (DEBT-506) — record only. */
const enforcesSameSite = (projectName: string) => projectName !== "webkit";

const loginForm = (page: Page) => page.locator('form[action="/login"]');

/** Click "Sign in" on the RP home and drive the IdP until claims ('claims') or the login form ('login'). */
async function signInFlow(page: Page, rp: X3Rp): Promise<"claims" | "login"> {
  await page.goto(`${rp.origin}/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  const consent = page.locator('form[action="/authorize/consent"]');
  const claims = page.getByTestId("claims");
  for (let i = 0; i < 4; i++) {
    await expect(loginForm(page).or(consent).or(claims).first()).toBeVisible({ timeout: 30_000 });
    if (await claims.isVisible()) return "claims";
    if (await loginForm(page).isVisible()) return "login";
    await consent.getByRole("button", { name: "Allow" }).click();
    await consent.waitFor({ state: "detached" });
  }
  await expect(claims).toBeVisible();
  return "claims";
}

/** Full interactive login on `rp` with the given credential; ends on the RP claims panel. */
async function login(page: Page, rp: X3Rp, email = DEV_SEED_EMAIL, password = DEV_SEED_PASSWORD) {
  expect(await signInFlow(page, rp)).toBe("login");
  await page.waitForURL((u) => u.hostname === X3_IDP_HOST && u.pathname === "/login", { waitUntil: "load" });
  await loginForm(page).getByLabel("Email").fill(email);
  await loginForm(page).getByLabel("Password").fill(password);
  await loginForm(page).getByRole("button", { name: "Sign in" }).click();
  const consent = page.locator('form[action="/authorize/consent"]');
  const claims = page.getByTestId("claims");
  for (let i = 0; i < 4 && !(await claims.isVisible()); i++) {
    await expect(consent.or(claims).first()).toBeVisible({ timeout: 30_000 });
    if (await consent.isVisible()) {
      await consent.getByRole("button", { name: "Allow" }).click();
      await consent.waitFor({ state: "detached" });
    }
  }
  await expect(claims).toBeVisible();
}

async function fresh(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function idpCookies(context: BrowserContext) {
  return (await context.cookies(X3_ISSUER)).filter((c) => c.name === SESSION);
}

/**
 * The session cookie as stored: `__Host-`, Secure, HttpOnly, Path=/, host-only on the IdP, and Lax
 * (Chromium/Firefox; WebKit-Windows stores it as `None` — it does not apply SameSite, DEBT-506).
 */
async function expectSessionCookieShape(context: BrowserContext, projectName: string, cellOf: Cell) {
  const all = await context.cookies();
  const sessions = all.filter((c) => c.name === SESSION);
  expect(sessions.length, "one __Host- session cookie").toBe(1);
  const [c] = sessions;
  expect(c.secure).toBe(true);
  expect(c.httpOnly).toBe(true);
  cellOf.storedSameSite = c.sameSite;
  if (enforcesSameSite(projectName)) expect(c.sameSite).toBe("Lax");
  expect(c.path).toBe("/");
  expect(c.domain, "host-only on the IdP").toBe(X3_IDP_HOST);
  expect(all.some((x) => x.name === LEGACY && x.domain.includes(X3_IDP_HOST)), "no legacy name set").toBe(false);
}


for (const label of ["alpha", "beta"] as X3Label[]) {
  const rp = X3_RPS[label];
  const other = X3_RPS[label === "alpha" ? "beta" : "alpha"];

  test.describe(`${rp.topology} (${rp.origin})`, () => {
    test(`1 interactive login — ${rp.topology}`, async ({ browser }, testInfo) => {
      const c = cell("1-login", rp.topology);
      const { context, page } = await fresh(browser);
      const idp = trackIdp(page);
      await login(page, rp);
      await expectSessionCookieShape(context, testInfo.project.name, c);
      const cb = await idp.find("POST", "/login");
      c.cookieNames = cb[0]?.names ?? [];
      c.outcome = "claims";
      await context.close();
    });

    test(`2 SSO second RP (top-level GET) — ${rp.topology}`, async ({ browser }) => {
      const c = cell("2-sso", rp.topology);
      const { context, page } = await fresh(browser);
      await login(page, other);
      const idp = trackIdp(page);
      const result = await signInFlow(page, rp);
      const auth = await idp.find("GET", "/authorize");
      c.cookieNames = auth[0]?.names ?? [];
      c.outcome = result;
      expect(result, "no login form: Lax is sent on a top-level GET").toBe("claims");
      expect(c.cookieNames).toContain(SESSION);
      await context.close();
    });

    test(`3 RP-initiated logout + replay — ${rp.topology}`, async ({ browser }) => {
      const c = cell("3-logout", rp.topology);
      const { context, page } = await fresh(browser);
      await login(page, rp);
      const before = await idpCookies(context);
      expect(before.length).toBe(1);
      const idp = trackIdp(page);
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.waitForURL((u) => u.hostname === X3_IDP_HOST && u.pathname === "/logout", { waitUntil: "load" });
      await page.locator('form[action="/logout"]').getByRole("button", { name: "Sign out", exact: true }).click();
      await page.waitForURL((u) => u.origin === rp.origin && u.pathname === "/");
      await expect(page.getByTestId("signed-out")).toBeVisible();
      c.cookieNames = (await idp.find("GET", "/logout"))[0]?.names ?? [];
      expect(await idpCookies(context), "session cookie cleared").toHaveLength(0);
      expect(await signInFlow(page, rp)).toBe("login");

      // Replay the pre-logout cookie into a new context: the revoked session must not come back.
      const replay = await fresh(browser);
      await replay.context.addCookies(
        before.map((k) => ({ name: k.name, value: k.value, url: X3_ISSUER, secure: true, httpOnly: true, sameSite: "Lax" as const })),
      );
      expect(await signInFlow(replay.page, rp), "replayed cookie is anonymous").toBe("login");
      c.outcome = "logged-out";
      await replay.context.close();
      await context.close();
    });

    test(`4 POST from RP to IdP without _csrf — ${rp.topology}`, async ({ browser }, testInfo) => {
      const c = cell("4-post", rp.topology);
      const { context, page } = await fresh(browser);
      await login(page, rp);
      const idp = trackIdp(page);
      const res = page.waitForResponse(
        (r) => new URL(r.url()).hostname === X3_IDP_HOST && r.request().method() === "POST",
      );
      await page.evaluate((action) => {
        const f = document.createElement("form");
        f.method = "POST";
        f.action = action;
        document.body.append(f);
        f.submit();
      }, `${X3_ISSUER}/logout`);
      const status = (await res).status();
      await page.waitForURL((u) => u.hostname === X3_IDP_HOST && u.pathname === "/logout", { waitUntil: "load" });
      c.cookieNames = (await idp.find("POST", "/logout"))[0]?.names ?? [];
      c.outcome = `HTTP ${status}`;
      expect(status, "state change refused").toBe(403);
      if (rp.topology === "cross-site" && enforcesSameSite(testInfo.project.name)) {
        expect(c.cookieNames, "Lax not sent on a cross-site POST").not.toContain(SESSION);
      }
      // Session survived: still one cookie, and SSO stays silent.
      expect(await idpCookies(context)).toHaveLength(1);
      expect(await signInFlow(page, rp)).toBe("claims");
      await context.close();
    });

    test(`5 fetch: Bearer via CORS + credentialed fetch — ${rp.topology}`, async ({ browser }, testInfo) => {
      const c = cell("5-fetch", rp.topology);
      const { context, page } = await fresh(browser);
      await login(page, rp);
      await page.getByRole("link", { name: "API test" }).click();
      await page.getByTestId("btn-userinfo").click();
      await expect(page.getByTestId("result-userinfo-verdict")).toContainText("HTTP 200");
      await page.getByTestId("btn-demo").click();
      await expect(page.getByTestId("result-demo-verdict")).toContainText("HTTP 200");
      // Credentialed fetch to the IdP host, answered by the X3 proxy echo (cookie names only).
      c.cookieNames = await page.evaluate(
        async (u) => (await (await fetch(u, { credentials: "include" })).json()) as string[],
        `${X3_ISSUER}/__x3_echo`,
      );
      c.outcome = "bearer 200";
      // Positive control of the instrument: same-site, Lax is sent on a credentialed fetch.
      if (rp.topology === "same-site") expect(c.cookieNames).toContain(SESSION);
      if (rp.topology === "cross-site" && enforcesSameSite(testInfo.project.name)) {
        expect(c.cookieNames, "Lax not sent on a cross-site fetch").not.toContain(SESSION);
      }
      await context.close();
    });

    test(`7 prompt=none in iframe (best-effort) — ${rp.topology}`, async ({ browser }) => {
      const c = cell("7-iframe", rp.topology);
      const { context, page } = await fresh(browser);
      await login(page, rp);
      // Stub the iframe's callback so the app never consumes it; only the outcome kind is read.
      await context.route(`${rp.origin}/callback**`, (route) =>
        route.request().frame() !== page.mainFrame()
          ? route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>cb</title>" })
          : route.continue(),
      );
      const verifier = randomBytes(32).toString("base64url");
      const url = new URL(`${X3_ISSUER}/authorize`);
      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id: rp.clientId,
        redirect_uri: `${rp.origin}/callback`,
        scope: "openid",
        state: randomBytes(16).toString("base64url"),
        nonce: randomBytes(16).toString("base64url"),
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        resource: `${X3_ISSUER}/demo/`,
        prompt: "none",
      })) {
        url.searchParams.set(k, v);
      }
      await page.evaluate((src) => {
        const f = document.createElement("iframe");
        f.src = src;
        document.body.append(f);
      }, url.toString());
      let outcome = "blocked";
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && outcome === "blocked") {
        for (const f of page.frames()) {
          if (f === page.mainFrame()) continue;
          const u = new URL(f.url() || "about:blank");
          if (u.origin !== rp.origin || u.pathname !== "/callback") continue;
          const err = u.searchParams.get("error");
          outcome = u.searchParams.has("code") ? "code" : err && /^[a-z_]+$/.test(err) ? err : "other";
        }
        if (outcome === "blocked") await page.waitForTimeout(250);
      }
      c.outcome = outcome;
      test.info().annotations.push({ type: "x3-silent", description: `${rp.topology}: ${outcome}` });
      await context.close();
    });
  });
}

test("6 cookie tossing from sibling app.alpha (DEBT-008)", async ({ browser }, testInfo) => {
  const c = cell("6-tossing", "sibling (same-site)");
  const rp = X3_RPS.alpha;

  const victim = await fresh(browser);
  await login(victim.page, rp, E2E_USER_EMAIL, E2E_USER_PASSWORD);
  const [victimSid] = await idpCookies(victim.context);
  expect(victimSid).toBeTruthy();

  const a = await fresh(browser);
  await login(a.page, rp);
  const subA = await a.page.getByTestId("claim-sub").textContent();

  // From the sibling RP page: a __Host- cookie with Domain must be rejected; a legacy-name domain
  // cookie carrying a valid sid reaches the IdP but must be ignored.
  await a.page.evaluate((sid) => {
    document.cookie = "__Host-idp_session=x3toss; Domain=alpha.localhost; Path=/; Secure";
    document.cookie = `idp_session=${sid}; Domain=alpha.localhost; Path=/; Secure`;
  }, victimSid.value);
  const jar = await a.context.cookies();
  expect(jar.filter((k) => k.name === SESSION && k.domain !== X3_IDP_HOST), "tossed __Host- rejected").toHaveLength(0);
  expect(jar.some((k) => k.name === LEGACY && k.domain === ".alpha.localhost"), "legacy toss stored").toBe(true);
  await expectSessionCookieShape(a.context, testInfo.project.name, c);

  const idp = trackIdp(a.page);
  expect(await signInFlow(a.page, rp)).toBe("claims");
  const subAfter = await a.page.getByTestId("claim-sub").textContent();
  expect(subAfter === subA, "identity unchanged after tossing").toBe(true);
  c.cookieNames = (await idp.find("GET", "/authorize"))[0]?.names ?? [];

  // Anonymous context with only the tossed legacy cookie: still anonymous.
  const anon = await fresh(browser);
  await anon.page.goto(`${rp.origin}/`);
  await anon.page.evaluate((sid) => {
    document.cookie = `idp_session=${sid}; Domain=alpha.localhost; Path=/; Secure`;
  }, victimSid.value);
  expect(await signInFlow(anon.page, rp), "tossed legacy sid ignored").toBe("login");
  c.outcome = "rejected/ignored";
  await Promise.all([victim.context.close(), a.context.close(), anon.context.close()]);
});

test("8 idp_fed tossing from sibling app.alpha before a Google leg (DEBT-505)", async ({ browser }) => {
  const c = cell("8-fed-tossing", "sibling (same-site)");
  const rp = X3_RPS.alpha;
  const FED = "__Host-idp_fed";
  const TOSS = "x3toss";

  const { context, page } = await fresh(browser);
  await page.goto(`${rp.origin}/`);
  await page.evaluate((v) => {
    document.cookie = `idp_fed=${v}; Domain=alpha.localhost; Path=/auth/; Secure`;
    document.cookie = `__Host-idp_fed=${v}; Domain=alpha.localhost; Path=/; Secure`;
  }, TOSS);
  const tossed = await context.cookies();
  expect(tossed.filter((k) => k.name === FED), "tossed __Host- rejected").toHaveLength(0);
  expect(tossed.some((k) => k.name === "idp_fed" && k.domain === ".alpha.localhost"), "legacy toss stored").toBe(true);

  const idp = trackIdp(page);
  expect(await signInFlow(page, rp)).toBe("login");
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await page.waitForURL((u) => u.hostname === "127.0.0.1" && u.pathname === "/authorize", { waitUntil: "load" });
  const rand = randomBytes(6).toString("hex");
  await page.getByLabel("Subject").fill(`x3-g-${rand}`);
  await page.getByLabel("Email", { exact: true }).fill(`x3-fed-${rand}@example.com`);
  await page.getByRole("button", { name: "Continue" }).click();
  const consent = page.locator('form[action="/authorize/consent"]');
  const claims = page.getByTestId("claims");
  for (let i = 0; i < 4 && !(await claims.isVisible()); i++) {
    await expect(consent.or(claims).first()).toBeVisible({ timeout: 30_000 });
    if (await consent.isVisible()) {
      await consent.getByRole("button", { name: "Allow" }).click();
      await consent.waitFor({ state: "detached" });
    }
  }
  await expect(claims, "signed in through the Google leg").toBeVisible();

  const fed = (await context.cookies()).filter((k) => k.name === FED);
  expect(fed, "one __Host-idp_fed").toHaveLength(1);
  expect(fed[0].domain, "host-only on the IdP").toBe(X3_IDP_HOST);
  expect(fed[0].path).toBe("/");
  expect(fed[0].secure).toBe(true);
  expect(fed[0].value !== TOSS, "binding is not the tossed value").toBe(true);
  const cb = (await idp.find("GET", "/auth/google/callback"))[0];
  c.cookieNames = cb?.names ?? [];
  expect(c.cookieNames).toContain(FED);
  expect(c.cookieNames, "tossed idp_fed reached the callback (and was ignored)").toContain("idp_fed");
  c.outcome = "signed in; tossed ignored";
  await context.close();
});
