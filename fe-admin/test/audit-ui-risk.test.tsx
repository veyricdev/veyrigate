// Run 48 (A6.4) tester risk matrix, audit UI (same harness as audit-ui.test.tsx): prototype and
// tenant keys in the URL never reach the server fn, encoded/homoglyph emails refused in the form,
// a BE action the FE does not know renders as text, system actors never linked, IP/UA never in the
// URL, and a metadata key equal to a fixed label cannot hide or replace the real value.
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { listAudit } from "@/features/admin-api/audit";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AuditEvent } from "@/server/admin-api/schemas";

vi.mock("@/features/theme/ui-prefs", () => ({ getUiPrefs: vi.fn() }));
vi.mock("@/features/auth/viewer", () => ({ getViewer: vi.fn() }));
vi.mock("@/lib/route-boundary", () => ({ safely: (_where: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/features/admin-api/audit", () => ({ listAudit: vi.fn() }));
// The user page only needs to render its header here: its reads never settle.
vi.mock("@/features/admin-api/users", () =>
  Object.fromEntries(
    ["listUsers", "getUser", "listUserFamilies", "listUserConsents"].map((k) => [k, vi.fn(() => new Promise(() => {}))]),
  ),
);

const list = vi.mocked(listAudit);
const USER_ID = "0123456789abcdef01234567";
const ADMIN_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const EMAIL = "target.canary@example.com";
const EVENT: AuditEvent = {
  eventId: "ev-1",
  timestamp: "2026-10-23T01:02:03.004Z",
  actorType: "admin",
  actorId: ADMIN_ID,
  action: "ADMIN_USER_LOCKED",
  targetType: "user",
  targetId: USER_ID,
  clientId: null,
  ip: "203.0.113.9",
  userAgent: "Mozilla/5.0 canary-ua",
  requestId: "req-1",
  result: "success",
  reason: null,
  metadata: { count: 2 },
};
const VIEWER = { sub: ADMIN_ID, email: "admin@example.com", roles: ["tenant_admin"], tenantId: "t1" };
const ok = <T,>(data: T) => ({ ok: true as const, data });
const page = (items: AuditEvent[], nextCursor: string | null = null) => ok({ items, nextCursor }) as never;

beforeEach(() => {
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue(VIEWER);
  list.mockResolvedValue(page([EVENT]));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderAt(path: string) {
  const queryClient = createQueryClient();
  queryClient.setQueryDefaults(["admin"], { retry: false });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    Wrap: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
    { container: document as never }, // DEBT-312
  );
  return router;
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
const href = (router: ReturnType<typeof renderAt>) => router.state.location.href;
const lastCall = () => list.mock.calls.at(-1)![0] as { data: Record<string, unknown> };
const table = () => screen.findByRole("table", { name: /Audit events/ });
const rows = async () => within(await table()).getAllByRole("row").slice(1);

describe("tester: URL and form inputs", () => {
  it("__proto__ / constructor / tenantId / tenant search keys never reach the server fn, no pollution", async () => {
    const router = renderAt(
      "/audit?__proto__=%7B%22tenantId%22%3A%22t2%22%7D&constructor=%7B%22prototype%22%3A1%7D" +
        "&tenantId=t2&tenant_id=t2&action=TOKEN_REUSE_DETECTED",
    );
    await table();
    expect(lastCall().data).toEqual({ limit: 20, action: "TOKEN_REUSE_DETECTED" });
    expect(Object.getPrototypeOf(lastCall().data)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).tenantId).toBeUndefined();
    // A filter submit rebuilds the search from the form only: the stray keys are gone.
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await settle();
    expect(router.state.location.search).toEqual({ action: "TOKEN_REUSE_DETECTED" });
    expect(href(router)).not.toMatch(/tenant|__proto__|constructor/);
  });

  it.each([
    ["Actor id", "a%40b.c"],
    ["Target id", "a＠example.com"],
    ["Client id", "<script>"],
    ["Actor id", "javascript:alert(1)"],
  ])("%s %j: refused in the form, no navigation, no request", async (label, value) => {
    const router = renderAt("/audit");
    await table();
    const calls = list.mock.calls.length;
    const before = href(router);
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await settle();
    expect(screen.getByLabelText(label).getAttribute("aria-invalid")).toBe("true");
    expect(href(router)).toBe(before);
    expect(list.mock.calls.length).toBe(calls);
  });

  it("an email in one field blocks the whole submit (the valid fields are not sent alone)", async () => {
    const router = renderAt("/audit");
    await table();
    const calls = list.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Actor id"), { target: { value: "ok-1" } });
    fireEvent.change(screen.getByLabelText("Target id"), { target: { value: EMAIL } });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await settle();
    expect(router.state.location.search).toEqual({});
    expect(list.mock.calls.length).toBe(calls);
    expect(JSON.stringify(list.mock.calls)).not.toContain(EMAIL);
  });

  it("a hand-made URL with an email in every id filter: dropped from the request and the form", async () => {
    const e = encodeURIComponent(EMAIL);
    renderAt(`/audit?actorId=${e}&targetId=${e}&clientId=${e}`);
    await table();
    expect(lastCall().data).toEqual({ limit: 20 });
    for (const label of ["Actor id", "Target id", "Client id"]) {
      expect(screen.getByLabelText<HTMLInputElement>(label).value).toBe("");
    }
    expect(document.body.textContent).not.toContain(EMAIL);
  });
});

describe("tester: rendering", () => {
  it("an action/actorType the FE does not know renders as text, unmarked, with Details working", async () => {
    list.mockResolvedValue(page([{ ...EVENT, eventId: "n", action: "SOMETHING_NEW", actorType: "robot", actorId: USER_ID, targetType: null, targetId: null }]));
    renderAt("/audit");
    const [row] = await rows();
    expect(within(row!).getByText("SOMETHING_NEW")).toBeTruthy();
    expect(within(row!).getByText("robot")).toBeTruthy();
    expect(screen.queryByText(/Security alert/)).toBeNull();
    // Not a user/admin actor: no user link even for a 24-hex id.
    expect(within(row!).queryByRole("link", { name: USER_ID })).toBeNull();
    fireEvent.click(within(row!).getByRole("button", { name: "Details" }));
    expect(screen.getByText("count")).toBeTruthy();
  });

  it("system actor and non-user targets are never linked; reuse label is text inside the row", async () => {
    list.mockResolvedValue(
      page([
        { ...EVENT, eventId: "s", actorType: "system", actorId: USER_ID, targetType: "client", targetId: "app-1", clientId: null },
        { ...EVENT, eventId: "r", action: "TOKEN_REUSE_DETECTED", actorType: "client", actorId: "app-1", clientId: "app-1", targetType: null, targetId: null, result: "failure" },
      ]),
    );
    renderAt("/audit");
    const [system, reuse] = await rows();
    expect(within(system!).queryAllByRole("link")).toHaveLength(0);
    const label = within(reuse!).getByText("Security alert: token reuse");
    expect(label.tagName).toBe("STRONG");
    expect(within(reuse!).getByText("Failure")).toBeTruthy();
    expect(within(reuse!).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/clients/app-1"]);
  });

  it("opening Details never puts IP/UA/requestId into the URL or a new request", async () => {
    const router = renderAt("/audit?action=ADMIN_USER_LOCKED");
    const [row] = await rows();
    const calls = list.mock.calls.length;
    const before = href(router);
    fireEvent.click(within(row!).getByRole("button", { name: "Details" }));
    await settle();
    expect(href(router)).toBe(before);
    for (const v of [EVENT.ip!, "canary-ua", "req-1"]) expect(href(router)).not.toContain(v);
    expect(list.mock.calls.length).toBe(calls);
  });

  it("a metadata key equal to a fixed label (IP) cannot hide or replace the real IP", async () => {
    list.mockResolvedValue(page([{ ...EVENT, metadata: { IP: "198.51.100.66", count: 1 } }]));
    renderAt("/audit");
    const [row] = await rows();
    fireEvent.click(within(row!).getByRole("button", { name: "Details" }));
    const panel = document.getElementById(within(row!).getByRole("button", { name: "Details" }).getAttribute("aria-controls")!)!;
    expect(within(panel).getByText(EVENT.ip!)).toBeTruthy();
    expect(within(panel).getByText("198.51.100.66")).toBeTruthy();
    expect(within(panel).getAllByText("IP")).toHaveLength(2);
  });
});
