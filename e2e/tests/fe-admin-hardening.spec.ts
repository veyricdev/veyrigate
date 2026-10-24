import { test, expect } from "@playwright/test";
import { FE_ADMIN_URL } from "../config/env";
import { isAdminApp, isIdp, signInAsAdmin } from "./support/fe-admin";

/**
 * Run 51 Task 4 (A7): CSP + security headers on the real fe-admin (dev server, as in every E2E).
 *  - Walks the main pages signed in as the E2E admin (super_admin), opens an audit entry, changes
 *    the theme, toggles the sidebar, reloads, then signs out with the form (303 to the IdP's
 *    end_session: the `form-action` check). Zero CSP violations on any fe-admin document, from the
 *    `securitypolicyviolation` listener and from the console ("Content Security Policy"/"Refused to").
 *  - Document headers of `/` and `/clients`: CSP with a nonce and no unsafe-inline in script-src,
 *    frame-ancestors 'none', DENY, nosniff, same-origin referrer, no-store; every <script> of the raw
 *    HTML carries that same nonce; two loads => two nonces. A `/_serverFn` response has them too.
 *  - Cookies: fea_sid HttpOnly + Lax; theme / sidebar_state Lax (http here, so no Secure check).
 * Removing `withSecurityHeaders` from `src/server.ts` is only caught here (unit tests call it directly).
 * Nothing token-like or nonce-like is printed.
 */

type Violation = { directive: string; blocked: string; doc: string; source: string };

const scriptSrc = (csp: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src ")) ?? "";
const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(scriptSrc(csp))?.[1];

/** Checks the document security headers; returns the script nonce of the CSP. */
function expectDocumentHeaders(h: Record<string, string>, label: string): string {
  const csp = h["content-security-policy"] ?? "";
  const nonce = nonceOf(csp);
  expect(nonce, `${label}: script-src has a nonce`).toBeTruthy();
  expect(scriptSrc(csp), `${label}: no unsafe-inline in script-src`).not.toContain("unsafe-inline");
  expect(csp, label).toContain("frame-ancestors 'none'");
  expect(h["x-frame-options"], label).toBe("DENY");
  expect(h["x-content-type-options"], label).toBe("nosniff");
  expect(h["referrer-policy"], label).toBe("same-origin");
  expect(h["cache-control"] ?? "", label).toContain("no-store");
  return nonce!;
}

test("fe-admin hardening: strict CSP with per-response nonce, 0 violations across the console, headers, cookies", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const violations: Violation[] = [];
  await context.exposeBinding("__cspReport", (_source, v: Violation) => void violations.push(v));
  await context.addInitScript(() => {
    const w = window as unknown as { __csp: unknown[]; __cspReport?: (v: unknown) => void };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      const v = {
        directive: e.violatedDirective,
        blocked: e.blockedURI,
        doc: e.documentURI,
        source: `${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`,
      };
      w.__csp.push(v);
      void w.__cspReport?.(v);
    });
  });
  const page = await context.newPage();
  const consoleCsp: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to/.test(text) && isAdminApp(new URL(page.url()))) consoleCsp.push(text.slice(0, 200));
  });
  const adminViolations = () => violations.filter((v) => isAdminApp(new URL(v.doc)));
  const expectClean = (where: string) => {
    expect(adminViolations(), `${where}: CSP violations (listener)`).toEqual([]);
    expect(consoleCsp, `${where}: CSP lines in the console`).toEqual([]);
  };
  const visit = async (path: string) => {
    const res = await page.goto(`${FE_ADMIN_URL}${path}`, { waitUntil: "networkidle" });
    expect(res?.status(), path).toBe(200);
    expectClean(path);
    return res;
  };

  try {
    await page.goto(`${FE_ADMIN_URL}/`);
    await signInAsAdmin(page);
    await page.waitForLoadState("networkidle");
    expectClean("after sign-in");

    // Document headers + nonce on every SSR script, two loads => two nonces.
    const nonces: string[] = [];
    for (const path of ["/", "/clients"]) {
      const res = await visit(path);
      nonces.push(expectDocumentHeaders(await res!.allHeaders(), path));
      const raw = await context.request.get(`${FE_ADMIN_URL}${path}`, { maxRedirects: 0 });
      expect(raw.status(), `raw ${path}`).toBe(200);
      const nonce = expectDocumentHeaders(raw.headers(), `raw ${path}`);
      nonces.push(nonce);
      const scripts = (await raw.text()).match(/<script\b[^>]*>/g) ?? [];
      expect(scripts.length, `raw ${path}: scripts`).toBeGreaterThan(0);
      const withNonce = scripts.filter((s) => s.includes(`nonce="${nonce}"`)).length;
      expect(withNonce, `raw ${path}: every <script> carries the header nonce`).toBe(scripts.length);
    }
    expect(new Set(nonces).size, "every load got its own nonce").toBe(nonces.length);

    // Client-side navigation: a /_serverFn response carries the headers too.
    await visit("/");
    const fnResponse = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith("/_serverFn"));
    await page.getByRole("link", { name: "Open clients" }).click();
    const fn = await (await fnResponse).allHeaders();
    expect(fn["content-security-policy"] ?? "").toContain("frame-ancestors 'none'");
    expect(fn["x-content-type-options"]).toBe("nosniff");
    expect(fn["cache-control"] ?? "").toContain("no-store");
    await page.waitForLoadState("networkidle");
    expectClean("/clients (client-side)");

    // Main pages (full SSR loads), with a detail page reached by its link.
    await visit("/clients");
    await page.locator('table a[href^="/clients/"]').first().click();
    await page.waitForURL((u) => isAdminApp(u) && /^\/clients\/[^/]+$/.test(u.pathname));
    await page.waitForLoadState("networkidle");
    expectClean("client detail");
    await visit("/clients/new");
    await visit("/resources");
    await visit("/users");
    await page.locator('table a[href^="/users/"]').first().click();
    await page.waitForURL((u) => isAdminApp(u) && /^\/users\/[^/]+$/.test(u.pathname));
    await page.waitForLoadState("networkidle");
    expectClean("user detail");
    await visit("/audit");
    const details = page.getByRole("button", { name: /^Details for / }).first();
    await details.click();
    await expect(details).toHaveAttribute("aria-expanded", "true");
    expectClean("audit details");
    await visit("/keys");

    // Theme + sidebar (JS-written cookies), then a reload renders them from the server.
    await page.getByRole("button", { name: /^Change theme/ }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    expectClean("theme + sidebar + reload");

    const cookies = await context.cookies(FE_ADMIN_URL);
    const byName = (n: string) => cookies.find((c) => c.name === n);
    expect(byName("fea_sid")?.httpOnly).toBe(true);
    expect(byName("fea_sid")?.sameSite).toBe("Lax");
    for (const n of ["theme", "sidebar_state"]) expect(byName(n)?.sameSite, n).toBe("Lax");

    // Sign out with the form: 303 to the IdP end_session (allowed by form-action).
    await page.getByRole("banner").getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL((url) => isIdp(url) && url.pathname === "/logout", { waitUntil: "load" });
    expectClean("logout");
    await page.locator('form[action="/logout"]').getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForURL((url) => isIdp(url) && url.pathname === "/login", { waitUntil: "load" });
    expectClean("end");
  } finally {
    await context.close();
  }
});
