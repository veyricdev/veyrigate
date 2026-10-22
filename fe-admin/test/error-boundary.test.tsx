// @vitest-environment node
// DEBT-275 canaries: an unintended server error never reaches the SSR HTML (router dehydration) or
// a /_serverFn response body; the server log keeps the detail under a request id.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Outlet,
  Scripts,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { RouterServer, attachRouterServerSsrUtils, renderRouterToString } from "@tanstack/react-router/ssr/server";
import { safely } from "@/lib/route-boundary";
import { ServiceUnavailableError, withErrorPage } from "@/server/errors";

const setResponseStatus = vi.fn();
vi.mock("@tanstack/react-start/server", () => ({ setResponseStatus: (s: number) => setResponseStatus(s) }));

let logged: string[];
let canary: string;
beforeEach(() => {
  logged = [];
  canary = `CANARY-${randomUUID()}`;
  vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  setResponseStatus.mockReset();
});

const requestIdIn = (s: string) => /request id ([0-9a-f-]{36})/.exec(s)?.[1];

/** Real router SSR (same steps as Start's handler): load, dehydrate, render to a string. */
async function ssr(routes: { beforeLoad?: () => Promise<unknown>; loader?: () => Promise<unknown> }) {
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
  const page = createRoute({ getParentRoute: () => root, path: "/", ...routes, component: () => <p>ok</p> });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    isServer: true,
  });
  attachRouterServerSsrUtils({ router, manifest: undefined });
  await router.load();
  await router.serverSsr!.dehydrate();
  const res = await renderRouterToString({
    router,
    responseHeaders: new Headers(),
    children: <RouterServer router={router} />,
  });
  return res.text();
}

describe("loader / beforeLoad boundary (SSR HTML)", () => {
  it("control: without the boundary the canary DOES reach the HTML (the test can see it)", async () => {
    const html = await ssr({
      loader: async () => {
        throw new Error(canary);
      },
    });
    expect(html).toContain(canary);
  });

  it("loader throwing => HTML has no canary, only a request id that the log also has", async () => {
    const html = await ssr({
      loader: () =>
        safely("test loader", async () => {
          throw new Error(canary);
        }),
    });
    expect(html).not.toContain(canary);
    const id = requestIdIn(html);
    expect(id).toBeDefined();
    expect(logged.join("\n")).toContain(id!);
    expect(logged.join("\n")).toContain(canary);
  });

  it("beforeLoad throwing => no canary in the HTML", async () => {
    const html = await ssr({
      beforeLoad: () =>
        safely("test beforeLoad", async () => {
          throw new Error(canary);
        }),
    });
    expect(html).not.toContain(canary);
    expect(requestIdIn(html)).toBeDefined();
  });

  it("redirect passes through untouched (guard keeps working)", async () => {
    const thrown = await safely("x", async () => {
      throw redirect({ href: "/auth/login" });
    }).catch((e: unknown) => e);
    expect((thrown as Response).headers.get("location")).toBe("/auth/login");
    expect(logged).toEqual([]);
  });
});

describe("server function boundary (/_serverFn body)", () => {
  async function runMiddleware(err: unknown): Promise<unknown> {
    const { startInstance } = await import("@/start");
    const opts = await startInstance.getOptions();
    const [mw] = opts.functionMiddleware as unknown as [
      { options: { server: (ctx: { next: () => Promise<unknown> }) => Promise<unknown> } },
    ];
    return mw.options
      .server({
        next: async () => {
          throw err;
        },
      })
      .catch((e: unknown) => e);
  }

  it("unintended error => fixed message + request id, serialised body has no canary, status 500", async () => {
    const thrown = await runMiddleware(new Error(canary));
    // Start serialises the thrown error (seroval: name, message, own properties): check them all,
    // stack and cause included.
    const err = thrown as Error;
    const body = JSON.stringify(
      Object.fromEntries(["name", "message", "stack", "cause", ...Object.keys(err)].map((k) => [k, String((err as never)[k])])),
    );
    expect(body).not.toContain(canary);
    expect(body).toContain("Internal error (request id");
    expect(logged.join("\n")).toContain(requestIdIn(body)!);
    expect(setResponseStatus).toHaveBeenCalledWith(500);
  });

  it("dependency down => 503 with a fixed message", async () => {
    const thrown = await runMiddleware(new ServiceUnavailableError("redis", { cause: new Error(canary) }));
    expect(String(thrown)).toMatch(/^PublicError: Service unavailable \(request id /);
    expect(String(thrown)).not.toContain(canary);
    expect(setResponseStatus).toHaveBeenCalledWith(503);
  });

  it("redirect is not swallowed", async () => {
    const r = redirect({ href: "/auth/login" });
    expect(await runMiddleware(r)).toBe(r);
    expect(setResponseStatus).not.toHaveBeenCalled();
  });
});

describe("server route boundary (/auth/*)", () => {
  it("a throwing handler => generic 500 page without the canary", async () => {
    const res = await withErrorPage("t", async () => {
      throw new Error(canary);
    })();
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain(canary);
    expect(body).not.toContain("<script");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("dependency down => 503 page", async () => {
    const res = await withErrorPage("t", async () => {
      throw new ServiceUnavailableError("redis");
    })();
    expect(res.status).toBe(503);
  });
});
