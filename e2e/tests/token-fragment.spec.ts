import { randomUUID } from "node:crypto";
import { test, expect, request, type Browser, type Page } from "@playwright/test";
import { BE_PORT, ISSUER } from "../config/env";

/**
 * One-time token in the URL fragment (run 86 T1, DEBT-577, D86.1–D86.3) on the real IdP UI with
 * Mailpit. The spec owns a dedicated user (register + verify through the fragment link). Then:
 *  - JS on: forgot => mail link `/reset#token=<43>` => the page fills and hides the code field and
 *    drops the fragment (`replaceState`); no request URL or Referer carries the token; `Continue`
 *    exchanges the token for the ticket cookie (run 94, DEBT-661) => the password form; the link
 *    opened in another context is then invalid, in the same context it shows the password form;
 *    the new password signs in;
 *  - JS off: the same link shows the "Code from the email" field; the code printed in the mail,
 *    `Continue`, then the password form resets the password.
 * URL waits use pathname/port predicates only (DEBT-108).
 */

const MAILPIT = "http://localhost:8025";
const isIdp = (url: URL) => url.port === String(BE_PORT);

const email = `e2e-frag-${randomUUID()}@example.com`;
const FIRST = `E2e-Frag1#${randomUUID()}`;
const SECOND = `E2e-Frag2#${randomUUID()}`;
const THIRD = `E2e-Frag3#${randomUUID()}`;

/** Newest mail to `to` whose link path is `path`, polled until a mail newer than `after` arrives. */
async function mailLink(to: string, path: string, after: Set<string>): Promise<{ link: string; code: string; id: string }> {
  const api = await request.newContext();
  try {
    let out = { link: "", code: "", id: "" };
    await expect
      .poll(
        async () => {
          const search = await api.get(`${MAILPIT}/api/v1/search`, { params: { query: `to:"${to}"` } });
          const found = ((await search.json()) as { messages?: { ID: string }[] }).messages ?? [];
          for (const { ID } of found) {
            if (after.has(ID)) continue;
            const msg = (await (await api.get(`${MAILPIT}/api/v1/message/${ID}`)).json()) as { Text?: string };
            const link = new RegExp(`https?://\\S+${path}\\S*`).exec(msg.Text ?? "")?.[0] ?? "";
            const code = /enter this code on the page: (\S+)/.exec(msg.Text ?? "")?.[1] ?? "";
            if (link && code) {
              out = { link, code, id: ID };
              return true;
            }
          }
          return false;
        },
        { timeout: 30_000, message: `${path} mail in Mailpit` },
      )
      .toBe(true);
    return out;
  } finally {
    await api.dispose();
  }
}

async function forgot(page: Page): Promise<void> {
  await page.goto(`${ISSUER}/forgot`);
  const form = page.locator('form[action="/forgot"]');
  await form.getByLabel("Email").fill(email);
  await form.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
}

async function signsIn(browser: Browser, password: string): Promise<void> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${ISSUER}/login`);
  const form = page.locator('form[action="/login"]');
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/");
  await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
  await page.context().close();
}

test.describe.configure({ mode: "serial" });

const seen = new Set<string>();

test("setup: register and verify through the fragment link", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${ISSUER}/register`);
  const reg = page.locator('form[action="/register"]');
  await reg.getByLabel("Email").fill(email);
  await reg.getByLabel("Password").fill(FIRST);
  await reg.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("a verification email has been sent")).toBeVisible();
  const verify = await mailLink(email, "/verify-email", seen);
  seen.add(verify.id);
  expect(new URL(verify.link).search).toBe("");
  expect(new URL(verify.link).hash).toBe(`#token=${verify.code}`);
  await page.goto(verify.link);
  // Run 91 (DEBT-671, D91.14): verifying the email also proves the password.
  await page.getByLabel("Password of the account").fill(FIRST);
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await page.context().close();
});

test("JS on: the fragment fills and hides the code field, is dropped, never sent; reset works", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await forgot(page);
  const reset = await mailLink(email, "/reset", seen);
  seen.add(reset.id);
  const link = new URL(reset.link);
  expect(link.search).toBe("");
  expect(link.pathname).toBe("/reset");
  expect(link.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/);

  const sent: string[] = [];
  page.on("request", (req) => sent.push(req.url(), req.headers()["referer"] ?? ""));
  await page.goto(reset.link);
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  expect(new URL(page.url()).pathname).toBe("/reset");
  const field = page.locator("#token");
  await expect(field).toHaveValue(reset.code);
  await expect(page.locator("#token-manual")).toBeHidden();

  // Run 94 (DEBT-661, D94.2/D94.3): nothing is exchanged on load; `Continue` swaps the token for the
  // ticket cookie and lands on `/reset` (no fragment) with the password form.
  await page.locator('form[action="/reset/code"]').getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/reset" && url.hash === "");
  const pwForm = page.locator('form[action="/reset"]');
  await expect(pwForm.getByLabel("New password")).toBeVisible();
  await expect(page.locator('input[name="token"]')).toHaveCount(0);
  expect(sent.some((u) => u.includes(reset.code)), "token in a request URL or Referer").toBe(false);

  // The link left in the history is dead: a new browser context gets the invalid page.
  const other = await (await browser.newContext()).newPage();
  await other.goto(reset.link);
  const refused = other.waitForResponse((r) => new URL(r.url()).pathname === "/reset/code");
  await other.getByRole("button", { name: "Continue" }).click();
  expect((await refused).status()).toBe(400);
  await expect(other.getByRole("heading", { name: "Request failed" })).toBeVisible();
  await expect(other.locator('form[action="/reset"]')).toHaveCount(0);
  await other.context().close();

  // The same context reopening the link holds the ticket: straight to the password form (leave
  // `/reset` first so the goto is a real load, not a same-document fragment change).
  await page.goto("about:blank");
  await page.goto(reset.link);
  await expect(page.locator('form[action="/reset/code"]')).toHaveCount(0);
  await expect(pwForm.getByLabel("New password")).toBeVisible();
  await pwForm.getByLabel("New password").fill(SECOND);
  await pwForm.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("heading", { name: "Password changed" })).toBeVisible();
  await ctx.close();
  await signsIn(browser, SECOND);
});

test("JS off: the code field is visible and the code from the mail resets the password", async ({ browser }) => {
  const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await forgot(page);
  const reset = await mailLink(email, "/reset", seen);
  seen.add(reset.id);
  await page.goto(reset.link);
  const codeForm = page.locator('form[action="/reset/code"]');
  const code = codeForm.getByLabel("Code from the email");
  await expect(code).toBeVisible();
  await expect(code).toHaveValue("");
  await code.fill(reset.code);
  await codeForm.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => isIdp(url) && url.pathname === "/reset");
  const form = page.locator('form[action="/reset"]');
  await form.getByLabel("New password").fill(THIRD);
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("heading", { name: "Password changed" })).toBeVisible();
  await page.context().close();
  await signsIn(browser, THIRD);
});
