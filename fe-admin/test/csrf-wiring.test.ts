// @vitest-environment node
// A7 (run 51 F3, Q-51.2): `start.ts` wires Start's CSRF middleware in front of every server
// function (`/_serverFn`, GET and POST) and fails closed: only a same-origin request reaches `next`.
// Exercised through the real request middleware list of `startInstance`, not the library alone.
import { describe, expect, it, vi } from "vitest";
import { startInstance } from "@/start";

const SERVER_FN_URL = "http://localhost:3000/_serverFn/abc";

type Server = (ctx: { request: Request; handlerType: string; next: () => unknown }) => unknown;

/** Runs the request middleware chain of `start.ts` the way Start does: each one calls the next. */
async function run(handlerType: string, method: string, headers: Record<string, string>) {
  const { requestMiddleware = [] } = await startInstance.getOptions();
  const servers = requestMiddleware.map((m) => (m as unknown as { options: { server: Server } }).options.server);
  const next = vi.fn(() => ({ request: undefined, response: new Response("ok") }));
  const request = new Request(SERVER_FN_URL, { method, headers });
  const step = (i: number): unknown =>
    i === servers.length ? next() : servers[i]!({ request, handlerType, next: () => step(i + 1) });
  const out = await step(0);
  return { next, out };
}

describe.each(["GET", "POST"])("server function %s: cross-site refused (403, next never called)", (method) => {
  it.each([
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }],
    ["Sec-Fetch-Site none", { "sec-fetch-site": "none" }],
    ["no SFS, foreign Origin", { origin: "http://evil.example" }],
    ["no SFS, Origin null", { origin: "null" }],
    ["no header at all", {}],
  ])("%s", async (_name, headers) => {
    const { next, out } = await run("serverFn", method, headers);
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ["Sec-Fetch-Site same-origin", { "sec-fetch-site": "same-origin" }],
    ["no SFS, same Origin", { origin: "http://localhost:3000" }],
  ])("%s => next", async (_name, headers) => {
    const { next } = await run("serverFn", method, headers);
    expect(next).toHaveBeenCalledOnce();
  });
});

it("a router request (pages, server routes) is not filtered by the server-function CSRF check", async () => {
  const { next } = await run("router", "GET", { "sec-fetch-site": "cross-site" });
  expect(next).toHaveBeenCalledOnce();
});
