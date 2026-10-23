// Run 50 (A6.6) tester risk matrix for the dashboard, beyond dashboard-ui.test.tsx:
// - DEBT-358: health "no retry" with the REAL query client (no `setQueryDefaults` override), so
//   dropping `retry: false` from `useBackendHealth` turns RED;
// - "Check again" disabled while pending, one request per click;
// - counts 99 / 100+nextCursor; tenant_admin sends no signing-keys request even across navigation;
// - security events: 1/2/3 failing queries => error block, Try again re-asks the failed ones only,
//   fail-closed while another query is still pending, tie-break by eventId, >10 cut, unknown /
//   HTML action rendered as text; every block fails on its own; unauthenticated => sign in again.
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { listClients } from "@/features/admin-api/clients";
import { listResourcePage } from "@/features/admin-api/resources";
import { listUsers } from "@/features/admin-api/users";
import { listAudit } from "@/features/admin-api/audit";
import { listSigningKeys } from "@/features/admin-api/signing-keys";
import { getBackendHealth } from "@/features/admin-api/health";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AdminApiErrorCode } from "@/features/admin-api/types";
import type { AuditEvent } from "@/server/admin-api/schemas";

vi.mock("@/features/theme/ui-prefs", () => ({ getUiPrefs: vi.fn() }));
vi.mock("@/features/auth/viewer", () => ({ getViewer: vi.fn() }));
vi.mock("@/lib/route-boundary", () => ({ safely: (_where: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/features/admin-api/clients", () => ({
  listClients: vi.fn(),
  getClient: vi.fn(),
  createClient: vi.fn(),
  updateClient: vi.fn(),
  listResources: vi.fn(),
}));
vi.mock("@/features/admin-api/resources", () => ({
  listResourcePage: vi.fn(),
  getResource: vi.fn(),
  createResource: vi.fn(),
  updateResource: vi.fn(),
}));
vi.mock("@/features/admin-api/users", () => ({
  listUsers: vi.fn(),
  getUser: vi.fn(),
  listUserFamilies: vi.fn(),
  listUserConsents: vi.fn(),
  lockUser: vi.fn(),
  unlockUser: vi.fn(),
  revokeUserSessions: vi.fn(),
  revokeUserFamily: vi.fn(),
  revokeUserConsent: vi.fn(),
}));
vi.mock("@/features/admin-api/audit", () => ({ listAudit: vi.fn() }));
vi.mock("@/features/admin-api/signing-keys", () => ({ listSigningKeys: vi.fn(), rotateSigningKey: vi.fn() }));
vi.mock("@/features/admin-api/health", () => ({ getBackendHealth: vi.fn() }));

const clients = vi.mocked(listClients);
const resources = vi.mocked(listResourcePage);
const users = vi.mocked(listUsers);
const audit = vi.mocked(listAudit);
const keys = vi.mocked(listSigningKeys);
const health = vi.mocked(getBackendHealth);

const SUPER = { sub: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "admin@example.com", roles: ["super_admin"], tenantId: "t1" };
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: AdminApiErrorCode) => ({ ok: false as const, error: { code, message: `msg ${code}` } });
const page = (n: number, nextCursor: string | null = null) => ok({ items: Array.from({ length: n }, (_, i) => ({ i })), nextCursor });
const empty = () => ok({ items: [], nextCursor: null });
const ACTIONS = ["TOKEN_REUSE_DETECTED", "SIGNING_KEY_ROTATED", "ADMIN_USER_LOCKED"] as const;

const ev = (action: string, eventId: string, timestamp: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  eventId,
  timestamp,
  actorType: "admin",
  actorId: SUPER.sub,
  action,
  targetType: "user",
  targetId: `target-${eventId}`,
  result: "success",
  ip: "203.0.113.9",
  userAgent: "UA-SECRET-AGENT",
  metadata: { mode: "normal" },
  ...extra,
});

type AuditArg = { data: { action: string; limit: number } };
let byAction: Record<string, () => Promise<unknown>>;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue(SUPER);
  clients.mockResolvedValue(page(3) as never);
  resources.mockResolvedValue(page(2) as never);
  users.mockResolvedValue(page(5) as never);
  health.mockResolvedValue(ok("up") as never);
  keys.mockResolvedValue(
    ok({
      items: [{ kid: "kid-active-1", alg: "RS256", status: "active", createdAt: "2026-10-23T01:00:00.000Z", retireAt: null }],
      nextCursor: null,
    }) as never,
  );
  byAction = Object.fromEntries(ACTIONS.map((a) => [a, async () => empty()]));
  audit.mockImplementation(((o: AuditArg) => byAction[o.data.action]!()) as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** `realRetry`: the app's query client as is (DEBT-358); otherwise `["admin"]` never retries (speed). */
function renderDashboard({ realRetry = false } = {}) {
  const queryClient = createQueryClient();
  if (!realRetry) queryClient.setQueryDefaults(["admin"], { retry: false });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    Wrap: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  return router;
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
const region = (name: string) => screen.findByRole("region", { name });
const eventsRegion = () => region("Recent security events");
const healthRegion = () => region("Identity provider status");
const healthStatus = async () => within(await healthRegion()).getByRole("status");
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("DEBT-358: health is never retried, with the real query client", () => {
  it.each([
    ["typed unavailable (transient)", async () => fail("unavailable")],
    ["thrown (transient)", async () => Promise.reject(new Error("boom"))],
  ])("%s => Unknown at once, one request even after 10 s", async (_n, impl) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    health.mockImplementation(impl as never);
    renderDashboard({ realRetry: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(health).toHaveBeenCalledTimes(1);
    expect((await healthStatus()).textContent).toBe("Identity provider: Unknown — no answer from the identity provider");
  });

  it("control: a count query with the same client IS retried (the fixture really keeps retries on)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    clients.mockResolvedValue(fail("unavailable") as never);
    renderDashboard({ realRetry: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(clients).toHaveBeenCalledTimes(3);
    expect(health).toHaveBeenCalledTimes(1);
  });
});

describe("Check again", () => {
  it("disabled while the check is pending; one request per click", async () => {
    renderDashboard();
    await waitFor(async () => expect((await healthStatus()).textContent).toContain("Up"));
    const pending = deferred<unknown>();
    health.mockImplementation((() => pending.promise) as never);
    const button = within(await healthRegion()).getByRole("button", { name: "Check again" }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    fireEvent.click(button);
    await settle();
    expect(health).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(ok("down")));
    await waitFor(async () => expect((await healthStatus()).textContent).toContain("Down"));
    expect(button.disabled).toBe(false);
    health.mockResolvedValue(ok("up") as never);
    fireEvent.click(button);
    await waitFor(async () => expect((await healthStatus()).textContent).toContain("Up"));
    expect(health).toHaveBeenCalledTimes(3);
  });

  it("no button while the first check is pending ('Checking…', never 'Up')", async () => {
    health.mockImplementation((() => new Promise(() => {})) as never);
    renderDashboard();
    await waitFor(async () => expect((await healthStatus()).textContent).toBe("Identity provider: Checking…"));
    expect(within(await healthRegion()).queryByRole("button")).toBeNull();
  });
});

describe("counts", () => {
  it("99 on the last page => '99'; 100 with a next cursor => '100+'", async () => {
    users.mockResolvedValue(page(99) as never);
    clients.mockResolvedValue(page(100, "c2") as never);
    renderDashboard();
    const u = await region("Users (this tenant)");
    await waitFor(() => expect(within(u).getByText("99")).toBeTruthy());
    expect(u.textContent).not.toMatch(/more than|\+/i);
    const c = await region("Clients (this tenant)");
    await waitFor(() => expect(within(c).getByText("100+")).toBeTruthy());
    expect(within(c).queryByText("100")).toBeNull();
  });
});

describe("signing keys gate across navigation", () => {
  it("tenant_admin: /, /keys, /clients and back to / => never a listSigningKeys call", async () => {
    vi.mocked(getViewer).mockResolvedValue({ ...SUPER, roles: ["tenant_admin"] });
    const router = renderDashboard();
    await region("Clients (this tenant)");
    await act(() => router.navigate({ to: "/keys" }));
    await screen.findByText("Only a super_admin can view and rotate signing keys.");
    await act(() => router.navigate({ to: "/clients" }));
    await settle();
    await act(() => router.navigate({ to: "/" }));
    await region("Clients (this tenant)");
    await settle();
    expect(screen.queryByRole("region", { name: "Signing keys" })).toBeNull();
    expect(keys).not.toHaveBeenCalled();
  });
});

describe("recent security events", () => {
  it.each([
    [["SIGNING_KEY_ROTATED"], 4],
    [["TOKEN_REUSE_DETECTED", "ADMIN_USER_LOCKED"], 5],
    [[...ACTIONS], 6],
  ] as const)("%j failing => error block; Try again asks only those again (total %i calls)", async (failing, total) => {
    for (const a of failing) byAction[a] = async () => fail("unavailable");
    if (!(failing as readonly string[]).includes("ADMIN_USER_LOCKED")) {
      byAction.ADMIN_USER_LOCKED = async () => ok({ items: [ev("ADMIN_USER_LOCKED", "l1", "2026-10-23T01:00:00.000Z")], nextCursor: null });
    }
    renderDashboard();
    const r = await eventsRegion();
    const alert = await within(r).findByRole("alert");
    expect(within(r).queryByRole("list")).toBeNull();
    expect(r.textContent).not.toContain("No recent security events");
    expect(r.textContent).not.toContain("target-");
    expect(audit).toHaveBeenCalledTimes(3);
    for (const a of failing) byAction[a] = async () => empty();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(r).queryByRole("alert")).toBeNull());
    await settle();
    expect(audit).toHaveBeenCalledTimes(total);
    const retried = audit.mock.calls.slice(3).map((c) => (c[0] as AuditArg).data.action);
    expect(new Set(retried)).toEqual(new Set(failing));
  });

  it("one failing while another is still pending => error, never a list or 'No recent'", async () => {
    byAction.TOKEN_REUSE_DETECTED = async () => fail("forbidden");
    byAction.SIGNING_KEY_ROTATED = () => new Promise(() => {});
    renderDashboard();
    const r = await eventsRegion();
    const alert = await within(r).findByRole("alert");
    expect(alert.textContent).toContain("msg forbidden");
    expect(r.textContent).not.toContain("No recent security events");
    expect(within(r).queryByRole("list")).toBeNull();
  });

  it("thrown (non-typed) failure => fixed text, not the raw error", async () => {
    byAction.SIGNING_KEY_ROTATED = async () => Promise.reject(new Error("redis://10.0.0.5:6379 stack at foo.ts:1"));
    renderDashboard();
    const alert = await within(await eventsRegion()).findByRole("alert");
    expect(alert.textContent).toContain("Recent security events could not be loaded.");
    expect(document.body.textContent).not.toMatch(/redis:|10\.0\.0\.5|foo\.ts/);
  });

  it("same timestamp across actions => eventId descending", async () => {
    const t = "2026-10-23T01:00:00.000Z";
    byAction.TOKEN_REUSE_DETECTED = async () => ok({ items: [ev("TOKEN_REUSE_DETECTED", "e1", t)], nextCursor: null });
    byAction.SIGNING_KEY_ROTATED = async () => ok({ items: [ev("SIGNING_KEY_ROTATED", "e3", t)], nextCursor: null });
    byAction.ADMIN_USER_LOCKED = async () => ok({ items: [ev("ADMIN_USER_LOCKED", "e2", t)], nextCursor: null });
    renderDashboard();
    const rows = within(await within(await eventsRegion()).findByRole("list")).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent!.match(/target-(e\d)/)![1])).toEqual(["e3", "e2", "e1"]);
  });

  it("3 x 10 events => the 10 newest overall", async () => {
    const t = (m: number) => `2026-10-23T02:${String(m).padStart(2, "0")}:00.000Z`;
    ACTIONS.forEach((a, k) => {
      // action k holds minutes k, k+3, ..., k+27 (newest first, as the BE pages)
      const items = Array.from({ length: 10 }, (_, i) => k + 3 * (9 - i)).map((m) => ev(a, `${a}-${m}`, t(m)));
      byAction[a] = async () => ok({ items, nextCursor: "more" });
    });
    renderDashboard();
    const rows = within(await within(await eventsRegion()).findByRole("list")).getAllByRole("listitem");
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => Number(r.textContent!.match(/2026-10-23T02:(\d\d)/)![1]))).toEqual([29, 28, 27, 26, 25, 24, 23, 22, 21, 20]);
  });

  it("an unknown or HTML action is rendered as text (no element, no label, encoded link)", async () => {
    const html = "<script>window.__pwned=1</script>";
    byAction.TOKEN_REUSE_DETECTED = async () =>
      ok({ items: [ev(html, "x1", "2026-10-23T01:02:00.000Z"), ev("FUTURE_ACTION", "x2", "2026-10-23T01:01:00.000Z")], nextCursor: null });
    renderDashboard();
    const r = await eventsRegion();
    const rows = within(await within(r).findByRole("list")).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain(html);
    expect(rows[1]!.textContent).toContain("FUTURE_ACTION");
    expect(r.textContent).not.toContain("Security alert");
    expect(r.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    for (const a of within(r).getAllByRole("link")) {
      const href = a.getAttribute("href")!;
      expect(href.startsWith("/audit")).toBe(true);
      expect(href).not.toMatch(/[<>"]/);
    }
  });
});

describe("every block fails on its own", () => {
  const blocks = {
    clients: () => clients.mockRejectedValue(new Error("x")),
    users: () => users.mockRejectedValue(new Error("x")),
    resources: () => resources.mockRejectedValue(new Error("x")),
    keys: () => keys.mockRejectedValue(new Error("x")),
    health: () => health.mockRejectedValue(new Error("x")),
    events: () => (byAction.ADMIN_USER_LOCKED = async () => Promise.reject(new Error("x"))),
  };
  it.each(Object.keys(blocks))("%s failing => the other blocks still render their data", async (name) => {
    blocks[name as keyof typeof blocks]();
    renderDashboard();
    const expectations: Record<string, () => Promise<void>> = {
      clients: async () => void (await within(await region("Clients (this tenant)")).findByText("3")),
      users: async () => void (await within(await region("Users (this tenant)")).findByText("5")),
      resources: async () => void (await within(await region("Resources (all tenants)")).findByText("2")),
      keys: async () => void (await within(await region("Signing keys")).findByText("kid-active-1")),
      health: async () => void (await waitFor(async () => expect((await healthStatus()).textContent).toContain("Up"))),
      events: async () => void (await within(await eventsRegion()).findByText("No recent security events in this tenant.")),
    };
    for (const [other, check] of Object.entries(expectations)) if (other !== name) await check();
    if (name === "health") {
      await waitFor(async () => expect((await healthStatus()).textContent).toContain("Unknown"));
    } else {
      expect(screen.getAllByRole("alert")).toHaveLength(1);
    }
  });
});

describe("session over", () => {
  // (the stubbed `location` has no pathname getter, so only the login prefix is asserted, as in client-secrets.test.tsx)
  it("health answering unauthenticated => sign in again", async () => {
    health.mockResolvedValue(fail("unauthenticated") as never);
    renderDashboard();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringMatching(/^\/auth\/login\?returnTo=/)));
  });
});
