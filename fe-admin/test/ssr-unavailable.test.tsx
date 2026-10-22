// @vitest-environment node
// DEBT-282: an SSR page whose guard/loader hit a dead dependency answers 503 (router alone says
// 500); other errors stay 500, an unknown page stays 404. Real router SSR inside the server-entry
// wrapper (`withUnavailableStatus`), same steps as Start's handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Outlet,
  Scripts,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { RouterServer, attachRouterServerSsrUtils, renderRouterToString } from "@tanstack/react-router/ssr/server";
import { safely } from "@/lib/route-boundary";
import { ServiceUnavailableError } from "@/server/errors";
import { markUnavailable, withUnavailableStatus } from "@/server/unavailable";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const CANARY = "CANARY-redis-host:6379";

async function ssr(path: string, beforeLoad?: () => Promise<unknown>): Promise<Response> {
  const root = createRootRoute({
    component: () => (
      <html lang="en">
        <head />
        <body>
          <Outlet />
          <Scripts />
        </body>
      </html>
    ),
    errorComponent: ({ error }) => <p>{String(error)}</p>,
  });
  const page = createRoute({ getParentRoute: () => root, path: "/", beforeLoad, component: () => <p>ok</p> });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer: true,
  });
  attachRouterServerSsrUtils({ router, manifest: undefined });
  await router.load();
  await router.serverSsr!.dehydrate();
  // Status from the router (getSsrStatus: 200/404/500 only), as in Start's handler.
  return renderRouterToString({
    router,
    responseHeaders: new Headers({ "content-type": "text/html" }),
    children: <RouterServer router={router} />,
  });
}

describe("server entry: 500 => 503 when a dependency is down", () => {
  it("guard hits Redis/IdP down => 503, generic HTML, no-store, no cookie cleared", async () => {
    const res = await withUnavailableStatus(() =>
      ssr("/", () =>
        safely("root beforeLoad", async () => {
          throw new ServiceUnavailableError("redis", { cause: new Error(CANARY) });
        }),
      ),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.getSetCookie()).toEqual([]);
    const html = await res.text();
    expect(html).toContain("Service unavailable (request id");
    expect(html).not.toContain(CANARY);
  });

  it("control: without the wrapper the router alone answers 500", async () => {
    const res = await ssr("/", () =>
      safely("root beforeLoad", async () => {
        throw new ServiceUnavailableError("redis");
      }),
    );
    expect(res.status).toBe(500);
  });

  it("an ordinary error stays 500", async () => {
    const res = await withUnavailableStatus(() =>
      ssr("/", () =>
        safely("root beforeLoad", async () => {
          throw new Error("bug");
        }),
      ),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("an unknown page stays 404 even if a dependency was flagged", async () => {
    const res = await withUnavailableStatus(async () => {
      markUnavailable();
      return ssr("/nope");
    });
    expect(res.status).toBe(404);
  });

  it("the flag is per request (a later request is not affected)", async () => {
    await withUnavailableStatus(async () => {
      markUnavailable();
      return new Response(null, { status: 500 });
    });
    expect((await withUnavailableStatus(async () => new Response(null, { status: 500 }))).status).toBe(500);
    markUnavailable(); // outside a request: no-op, no throw
  });
});
