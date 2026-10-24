// Run 51 tester lượt 3: the dashboard fires 8 independent queries on load; Sign out pressed while
// all 8 are pending must not navigate to /auth/login (the logout POST would be aborted). Plus a
// DEBT-374 characterisation: with the signing-out flag stuck (no unload, no bfcache restore) the
// root guard still sends a viewer-less navigation to login (fail closed), only the client-side
// automatic redirect is muted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, useQueries, type QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { beginSignOut, createQueryClient, isSigningOut, signInAgain } from "@/features/admin-api/query-client";
import { AdminRequestError, type AdminApiFailure } from "@/features/admin-api/types";
import { SignOutButton } from "@/features/auth/sign-out-button";
import { getViewer } from "@/features/auth/viewer";
import { Route as RootRoute } from "@/routes/__root";

vi.mock("@/features/theme/ui-prefs", () => ({ getUiPrefs: vi.fn() }));
vi.mock("@/features/auth/viewer", () => ({ getViewer: vi.fn() }));
vi.mock("@/lib/route-boundary", () => ({ safely: (_where: string, fn: () => Promise<unknown>) => fn() }));
const viewer = vi.mocked(getViewer);

const unauthenticated = () =>
  new AdminRequestError({ code: "unauthenticated", message: "Session expired" } as AdminApiFailure);

let assign: ReturnType<typeof vi.fn>;
let submits: SubmitEvent[];
const onSubmit = (event: Event) => submits.push(event as SubmitEvent);

beforeEach(() => {
  assign = vi.fn();
  submits = [];
  vi.stubGlobal("location", { ...window.location, pathname: "/", search: "", assign });
  document.addEventListener("submit", onSubmit);
});
afterEach(() => {
  cleanup();
  document.removeEventListener("submit", onSubmit);
  vi.unstubAllGlobals();
});

const KEYS = ["clients", "users", "resources", "keys", "health", "audit-a", "audit-b", "audit-c"];

function EightQueries({ rejects }: { rejects: ((e: unknown) => void)[] }) {
  const results = useQueries({
    queries: KEYS.map((k, i) => ({
      queryKey: [k],
      queryFn: () => new Promise<never>((_, r) => (rejects[i] = r)),
      retry: false,
    })),
  });
  return (
    <>
      <p>{results.filter((r) => r.isFetching).length} fetching</p>
      <SignOutButton />
    </>
  );
}

function renderDashboard(client: QueryClient) {
  const rejects: ((e: unknown) => void)[] = [];
  render(
    <QueryClientProvider client={client}>
      <EightQueries rejects={rejects} />
    </QueryClientProvider>,
  );
  return rejects;
}

describe("sign-out race with the 8 dashboard queries pending", () => {
  it("Sign out => 0 navigations to /auth/login, the logout form POST still submits", async () => {
    const client = createQueryClient();
    const rejects = renderDashboard(client);
    await waitFor(() => expect(client.isFetching()).toBe(8));
    expect(rejects).toHaveLength(8);

    fireEvent.submit(screen.getByRole("button", { name: "Sign out" }).closest("form")!);
    expect(submits).toHaveLength(1);
    expect(submits[0].defaultPrevented).toBe(false);
    expect((submits[0].target as HTMLFormElement).method).toBe("post");
    expect((submits[0].target as HTMLFormElement).getAttribute("action")).toBe("/auth/logout");
    expect(isSigningOut()).toBe(true);

    await act(async () => {
      for (const reject of rejects) reject(unauthenticated());
    });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("DEBT-374 characterisation: signing-out flag stuck (POST did not unload the page)", () => {
  it("automatic client redirect is muted, but the root guard still redirects a viewer-less navigation to login", async () => {
    beginSignOut(createQueryClient()); // no pageshow follows => flag stays on
    expect(isSigningOut()).toBe(true);

    signInAgain();
    expect(assign).not.toHaveBeenCalled(); // the UX gap DEBT-374 describes

    viewer.mockResolvedValue(null);
    const beforeLoad = RootRoute.options.beforeLoad as unknown as (ctx: {
      location: { href: string };
    }) => Promise<unknown>;
    let thrown: unknown;
    try {
      await beforeLoad({ location: { href: "/clients?x=1" } });
    } catch (err) {
      thrown = err;
    }
    expect(isRedirect(thrown)).toBe(true);
    const options = (thrown as { options: { href?: string; reloadDocument?: boolean } }).options;
    expect(options.href).toBe("/auth/login?returnTo=%2Fclients%3Fx%3D1");
    expect(options.reloadDocument).toBe(true);
  });

  it("control: with a viewer the guard lets the navigation through even while the flag is stuck", async () => {
    viewer.mockResolvedValue({ sub: "u1", email: "a@example.com", roles: ["super_admin"], tenantId: "t1" });
    const beforeLoad = RootRoute.options.beforeLoad as unknown as (ctx: {
      location: { href: string };
    }) => Promise<{ viewer: unknown }>;
    await expect(beforeLoad({ location: { href: "/" } })).resolves.toMatchObject({ viewer: { sub: "u1" } });
  });
});
