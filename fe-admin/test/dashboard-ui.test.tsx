// Run 50 (A6.6) dashboard through the real route tree under StrictMode (server fns mocked): counts
// from one page of 100 ("100+" while more pages exist), signing keys card for a super_admin only
// (no request otherwise), IdP readiness as text, recent security events from 3 per-action requests
// merged newest first and fail-closed, every block failing on its own, read once (no polling).
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
const TENANT_ADMIN = { ...SUPER, roles: ["tenant_admin"] };
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: AdminApiErrorCode) => ({ ok: false as const, error: { code, message: `msg ${code}` } });
const page = (n: number, nextCursor: string | null = null) => ok({ items: Array.from({ length: n }, (_, i) => ({ i })), nextCursor });

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
let byAction: Record<string, unknown>;

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue(SUPER);
  clients.mockResolvedValue(page(3) as never);
  resources.mockResolvedValue(page(2) as never);
  users.mockResolvedValue(page(5) as never);
  health.mockResolvedValue(ok("up") as never);
  keys.mockResolvedValue(
    ok({
      items: [
        { kid: "kid-active-1", alg: "RS256", status: "active", createdAt: "2026-10-23T01:00:00.000Z", retireAt: null },
        { kid: "kid-old-1", alg: "RS256", status: "retiring", createdAt: "2026-10-22T01:00:00.000Z", retireAt: "2026-10-23T02:00:00.000Z" },
      ],
      nextCursor: null,
    }) as never,
  );
  byAction = {
    TOKEN_REUSE_DETECTED: ok({ items: [], nextCursor: null }),
    SIGNING_KEY_ROTATED: ok({ items: [], nextCursor: null }),
    ADMIN_USER_LOCKED: ok({ items: [], nextCursor: null }),
  };
  audit.mockImplementation((async (o: AuditArg) => byAction[o.data.action]) as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderDashboard() {
  const queryClient = createQueryClient();
  queryClient.setQueryDefaults(["admin"], { retry: false });
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
const healthStatus = async () => within(await region("Identity provider status")).getByRole("status");

describe("counts", () => {
  it("one page of 100 per list; exact count on the last page, '100+' (More than 100) otherwise", async () => {
    clients.mockResolvedValue(page(100, "cursor-next") as never);
    users.mockResolvedValue(page(7) as never);
    resources.mockResolvedValue(page(0) as never);
    renderDashboard();
    const c = await region("Clients (this tenant)");
    await waitFor(() => expect(within(c).getByText("100+")).toBeTruthy());
    expect(within(c).getByText("More than 100")).toBeTruthy();
    expect(within(c).queryByText("100")).toBeNull();
    const u = await region("Users (this tenant)");
    await waitFor(() => expect(within(u).getByText("7")).toBeTruthy());
    expect(within(u).queryByText(/more than/i)).toBeNull();
    const r = await region("Resources (all tenants)");
    await waitFor(() => expect(within(r).getByText("0")).toBeTruthy());
    expect(clients).toHaveBeenCalledWith({ data: { limit: 100 } });
    expect(users).toHaveBeenCalledWith({ data: { limit: 100 } });
    expect(resources).toHaveBeenCalledWith({ data: { limit: 100 } });
  });

  it("exactly 100 on the last page is '100', not '100+'", async () => {
    users.mockResolvedValue(page(100) as never);
    renderDashboard();
    const u = await region("Users (this tenant)");
    await waitFor(() => expect(within(u).getByText("100")).toBeTruthy());
    expect(within(u).queryByText("100+")).toBeNull();
  });

  it("each card links to its list page", async () => {
    renderDashboard();
    expect(within(await region("Clients (this tenant)")).getByRole("link", { name: "Open clients" }).getAttribute("href")).toBe("/clients");
    expect(within(await region("Users (this tenant)")).getByRole("link", { name: "Open users" }).getAttribute("href")).toBe("/users");
    expect(within(await region("Resources (all tenants)")).getByRole("link", { name: "Open resources" }).getAttribute("href")).toBe("/resources");
  });
});

describe("signing keys card", () => {
  it("super_admin: active kid as text, retiring count, link to /keys", async () => {
    renderDashboard();
    const k = await region("Signing keys");
    await waitFor(() => expect(within(k).getByText("kid-active-1")).toBeTruthy());
    expect(within(k).getByText("1")).toBeTruthy();
    expect(within(k).queryByText("kid-old-1")).toBeNull();
    expect(within(k).getByRole("link", { name: "Open signing keys" }).getAttribute("href")).toBe("/keys");
  });

  it.each([
    ["tenant_admin", ["tenant_admin"]],
    ["case variant", ["tenant_admin", "SUPER_ADMIN"]],
    ["prefix", ["tenant_admin", "super_admin_x"]],
  ])("%s: no keys card and no listSigningKeys call", async (_n, roles) => {
    vi.mocked(getViewer).mockResolvedValue({ ...TENANT_ADMIN, roles });
    renderDashboard();
    await region("Clients (this tenant)");
    await settle();
    expect(screen.queryByRole("region", { name: "Signing keys" })).toBeNull();
    expect(keys).not.toHaveBeenCalled();
  });
});

describe("IdP status", () => {
  it.each([
    ["up", "Identity provider: Up"],
    ["down", "Identity provider: Down — a dependency is not ready"],
    ["unknown", "Identity provider: Unknown — no answer from the identity provider"],
  ])("%s => text", async (state, text) => {
    health.mockResolvedValue(ok(state) as never);
    renderDashboard();
    await waitFor(async () => expect((await healthStatus()).textContent).toBe(text));
  });

  it.each([
    ["typed failure", async () => fail("unavailable")],
    ["thrown", async () => Promise.reject(new Error("boom"))],
  ])("server fn %s => Unknown, asked once (no retry)", async (_n, impl) => {
    health.mockImplementation(impl as never);
    renderDashboard();
    await waitFor(async () => expect((await healthStatus()).textContent).toContain("Unknown"));
    await settle();
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("Check again asks once more", async () => {
    renderDashboard();
    await waitFor(async () => expect((await healthStatus()).textContent).toContain("Up"));
    health.mockResolvedValue(ok("down") as never);
    fireEvent.click(within(await region("Identity provider status")).getByRole("button", { name: "Check again" }));
    await waitFor(async () => expect((await healthStatus()).textContent).toContain("Down"));
    expect(health).toHaveBeenCalledTimes(2);
  });
});

describe("recent security events", () => {
  it("one request per action with limit 10, exactly 3", async () => {
    renderDashboard();
    await within(await eventsRegion()).findByText("No recent security events in this tenant.");
    expect(audit).toHaveBeenCalledTimes(3);
    expect(audit.mock.calls.map((c) => (c[0] as AuditArg).data)).toEqual(
      expect.arrayContaining([
        { action: "TOKEN_REUSE_DETECTED", limit: 10 },
        { action: "SIGNING_KEY_ROTATED", limit: 10 },
        { action: "ADMIN_USER_LOCKED", limit: 10 },
      ]),
    );
    expect(within(await eventsRegion()).getByText("Events recorded for this tenant.")).toBeTruthy();
  });

  it("merged newest first across actions, cut to 10; no IP/UA/metadata", async () => {
    const t = (m: number) => `2026-10-23T01:${String(m).padStart(2, "0")}:00.000Z`;
    byAction.TOKEN_REUSE_DETECTED = ok({ items: [5, 3, 1].map((m) => ev("TOKEN_REUSE_DETECTED", `r${m}`, t(m))), nextCursor: null });
    byAction.SIGNING_KEY_ROTATED = ok({
      items: [ev("SIGNING_KEY_ROTATED", "k12", t(12), { metadata: { mode: "emergency" } }), ...[8, 2].map((m) => ev("SIGNING_KEY_ROTATED", `k${m}`, t(m)))],
      nextCursor: null,
    });
    byAction.ADMIN_USER_LOCKED = ok({ items: [11, 10, 9, 7, 6, 4].map((m) => ev("ADMIN_USER_LOCKED", `l${m}`, t(m))), nextCursor: null });
    renderDashboard();
    const list = await within(await eventsRegion()).findByRole("list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(10);
    const times = rows.map((r) => r.textContent!.match(/2026-10-23T01:(\d\d)/)![1]);
    expect(times).toEqual(["12", "11", "10", "09", "08", "07", "06", "05", "04", "03"]);
    expect(rows[0]!.textContent).toContain("SIGNING_KEY_ROTATED");
    expect(rows[0]!.textContent).toContain("Security alert: emergency key rotation");
    expect(rows[7]!.textContent).toContain("Security alert: token reuse");
    expect(rows[1]!.textContent).toContain("target-l11");
    expect(rows[1]!.textContent).toContain("Success");
    const text = document.body.textContent!;
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain("UA-SECRET-AGENT");
  });

  it("each row links to /audit filtered by its action", async () => {
    byAction.ADMIN_USER_LOCKED = ok({ items: [ev("ADMIN_USER_LOCKED", "l1", "2026-10-23T01:00:00.000Z")], nextCursor: null });
    renderDashboard();
    const link = await within(await eventsRegion()).findByRole("link", { name: /View in audit log/ });
    expect(link.getAttribute("href")).toBe("/audit?action=ADMIN_USER_LOCKED");
  });

  it("targetId with HTML is shown as text", async () => {
    const xss = "<img src=x onerror=alert(1)>";
    byAction.TOKEN_REUSE_DETECTED = ok({ items: [ev("TOKEN_REUSE_DETECTED", "x1", "2026-10-23T01:00:00.000Z", { targetId: xss })], nextCursor: null });
    renderDashboard();
    const r = await eventsRegion();
    await waitFor(() => expect(r.textContent).toContain(xss));
    expect(r.querySelector("img")).toBeNull();
  });

  it.each(["TOKEN_REUSE_DETECTED", "SIGNING_KEY_ROTATED", "ADMIN_USER_LOCKED"])(
    "%s failing => whole block in error (no partial list, no 'No recent'); Try again recovers",
    async (action) => {
      byAction.ADMIN_USER_LOCKED = ok({ items: [ev("ADMIN_USER_LOCKED", "l1", "2026-10-23T01:00:00.000Z")], nextCursor: null });
      byAction.TOKEN_REUSE_DETECTED = ok({ items: [ev("TOKEN_REUSE_DETECTED", "r1", "2026-10-23T01:01:00.000Z")], nextCursor: null });
      const good = byAction[action];
      byAction[action] = fail("unavailable");
      renderDashboard();
      const r = await eventsRegion();
      const alert = await within(r).findByRole("alert");
      expect(alert.textContent).toContain("msg unavailable");
      expect(within(r).queryByRole("list")).toBeNull();
      expect(r.textContent).not.toContain("No recent security events");
      expect(r.textContent).not.toContain("target-");
      byAction[action] = good;
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
      await within(r).findByRole("list");
      expect(within(r).queryByRole("alert")).toBeNull();
      expect(audit).toHaveBeenCalledTimes(4); // only the failed action was asked again
    },
  );
});

describe("isolation and refresh", () => {
  it("users failing: only its card shows the error; the other blocks render", async () => {
    users.mockResolvedValue(fail("unavailable") as never);
    renderDashboard();
    const u = await region("Users (this tenant)");
    const alert = await within(u).findByRole("alert");
    expect(alert.textContent).toContain("msg unavailable");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    await waitFor(async () => expect(within(await region("Clients (this tenant)")).getByText("3")).toBeTruthy());
    expect(within(await region("Resources (all tenants)")).getByText("2")).toBeTruthy();
    expect((await healthStatus()).textContent).toContain("Up");
    expect(within(await region("Signing keys")).getByText("kid-active-1")).toBeTruthy();
    await within(await eventsRegion()).findByText("No recent security events in this tenant.");
    users.mockResolvedValue(page(4) as never);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(u).getByText("4")).toBeTruthy());
  });

  it("a thrown (non-typed) failure shows a fixed text, not the raw error", async () => {
    clients.mockRejectedValue(new Error("mongodb://internal-host:27017 ECONNREFUSED"));
    renderDashboard();
    const alert = await within(await region("Clients (this tenant)")).findByRole("alert");
    expect(alert.textContent).toContain("The count could not be loaded.");
    expect(document.body.textContent).not.toContain("internal-host");
  });

  it("read once: no polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderDashboard();
      await waitFor(async () => expect((await healthStatus()).textContent).toContain("Up"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });
      expect(clients).toHaveBeenCalledTimes(1);
      expect(users).toHaveBeenCalledTimes(1);
      expect(resources).toHaveBeenCalledTimes(1);
      expect(keys).toHaveBeenCalledTimes(1);
      expect(health).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the page URL carries no query", async () => {
    const router = renderDashboard();
    await region("Clients (this tenant)");
    expect(router.state.location.href).toBe("/");
  });
});
