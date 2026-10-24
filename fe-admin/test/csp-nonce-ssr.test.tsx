// @vitest-environment node
// A7 (DEBT-269): the nonce of the server entry reaches the router, and the router puts it on every
// script it streams (initial `$_TSR`, deferred-data chunks, React's Suspense `$RC`), plus the
// `<meta property="csp-nonce">` the browser reads back on hydration.
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
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
import { z } from "zod";
import { getRouter } from "@/router";
import { withSecurityHeaders } from "@/server/security-headers";

const nonceOf = (res: Response) => /'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];

describe("getRouter(): ssr.nonce from the server entry", () => {
  it("(a) inside withSecurityHeaders = the header's nonce; outside = undefined", async () => {
    let seen: string | undefined;
    const res = await withSecurityHeaders(() => {
      seen = getRouter().options.ssr?.nonce;
      return new Response("x");
    });
    expect(seen).toBeDefined();
    expect(seen).toBe(nonceOf(res));
    expect(getRouter().options.ssr?.nonce).toBeUndefined();
  });
});

describe("streamed SSR: every script carries the nonce", () => {
  it("(b) deferred loader data + Suspense => all <script> have nonce=N, meta csp-nonce present", async () => {
    const N = "TEST-nonce-abc123==";
    const root = createRootRoute({
      head: () => ({ meta: [{ title: "t" }] }),
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
      loader: () => ({ slow: new Promise<string>((resolve) => setTimeout(() => resolve("streamed"), 20)) }),
      component: function Page() {
        const { slow } = page.useLoaderData() as unknown as { slow: Promise<string> };
        return (
          <Suspense fallback={<p>loading</p>}>
            <Await promise={slow}>{(v) => <p>{v}</p>}</Await>
          </Suspense>
        );
      },
    });
    const router = createRouter({
      routeTree: root.addChildren([page]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      isServer: true,
      ssr: { nonce: N },
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
    const html = await response.text();

    expect(html).toContain("streamed");
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    for (const tag of scripts) expect(tag).toContain(`nonce="${N}"`);
    expect(html).toMatch(new RegExp(`<meta[^>]*property="csp-nonce"[^>]*content="${N}"|<meta[^>]*content="${N}"[^>]*property="csp-nonce"`));
  });
});

describe("zod under the strict CSP", () => {
  it("(c) loading the router turns zod's JIT off: no `new Function` eval probe in the browser", () => {
    expect(z.config().jitless).toBe(true);
  });
});
