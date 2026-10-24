// @vitest-environment node
// A7 (run 51, tester): two requests handled at the same time, interleaved across awaits, each get
// their own nonce from the real `getRouter()`, and each streamed HTML carries only its own nonce
// (no cross-request leak through the per-request store). No nonce is ever written to the console.
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Await,
  HeadContent,
  Outlet,
  Scripts,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { RouterServer, attachRouterServerSsrUtils, renderRouterToStream } from "@tanstack/react-router/ssr/server";
import { getRouter } from "@/router";
import { currentCspNonce, withSecurityHeaders } from "@/server/security-headers";

const nonceOf = (res: Response) => /'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Streams a page whose loader waits on `gate`, with the nonce the real app router got. */
async function renderPage(gate: Promise<void>, label: string): Promise<Response> {
  const nonce = getRouter().options.ssr?.nonce;
  const root = createRootRoute({
    component: () => (
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          <Outlet />
          <Scripts />
        </body>
      </html>
    ),
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    loader: () => ({ slow: gate.then(() => `${label}:${currentCspNonce()}`) }),
    component: function Page() {
      const { slow } = page.useLoaderData() as unknown as { slow: Promise<string> };
      return (
        <Suspense fallback={<p>loading</p>}>
          <Await promise={slow}>{(v) => <p id="v">{v}</p>}</Await>
        </Suspense>
      );
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    isServer: true,
    ssr: { nonce },
  });
  attachRouterServerSsrUtils({ router, manifest: undefined });
  await router.load();
  await router.serverSsr!.dehydrate();
  const { response } = await renderRouterToStream({
    request: new Request("http://localhost/"),
    router,
    responseHeaders: new Headers({ "content-type": "text/html" }),
    children: <RouterServer router={router} />,
  });
  return response;
}

afterEach(() => vi.restoreAllMocks());

describe("concurrent requests: one nonce each, no cross-request leak", () => {
  it("interleaved A/B: each HTML has only its own nonce on every script; logs never hold a nonce", async () => {
    const logged: string[] = [];
    for (const level of ["error", "warn", "log", "info", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
    const gateA = deferred();
    const gateB = deferred();
    const startedB = deferred();
    // A starts, B starts, then B finishes its deferred data BEFORE A (interleaving across awaits).
    const a = withSecurityHeaders(async () => {
      const res = await renderPage(gateA.promise, "A");
      return res;
    });
    const b = withSecurityHeaders(async () => {
      startedB.resolve();
      return renderPage(gateB.promise, "B");
    });
    await startedB.promise;
    gateB.resolve();
    const resB = await b;
    const htmlB = await resB.text();
    gateA.resolve();
    const resA = await a;
    const htmlA = await resA.text();

    const nA = nonceOf(resA)!;
    const nB = nonceOf(resB)!;
    expect(nA).toBeDefined();
    expect(nB).toBeDefined();
    expect(nA).not.toBe(nB);
    for (const [html, own, other, label] of [
      [htmlA, nA, nB, "A"],
      [htmlB, nB, nA, "B"],
    ] as const) {
      // the deferred value was computed inside the request's own store
      expect(html).toContain(`${label}:${own}`);
      const scripts = html.match(/<script\b[^>]*>/g) ?? [];
      expect(scripts.length).toBeGreaterThanOrEqual(2);
      for (const tag of scripts) expect(tag).toContain(`nonce="${own}"`);
      expect(html).not.toContain(other);
    }
    expect(currentCspNonce()).toBeUndefined();
    const text = logged.join("\n");
    expect(text).not.toContain(nA);
    expect(text).not.toContain(nB);
  });

  it("20 parallel requests get 20 distinct nonces, each seen inside its own handler", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        let inside: string | undefined;
        const res = await withSecurityHeaders(async () => {
          await new Promise<void>((r) => setImmediate(r));
          if (i % 2) await Promise.resolve();
          inside = getRouter().options.ssr?.nonce;
          return new Response("x");
        });
        return { header: nonceOf(res), inside };
      }),
    );
    for (const r of results) expect(r.inside).toBe(r.header);
    expect(new Set(results.map((r) => r.header)).size).toBe(20);
  });
});
