// Run 48 (A6.4) audit UI through the real route tree under StrictMode (server fn mocked): filters as
// search params, ids checked before any navigation (an email never reaches the URL), junk search
// dropped, security events marked with text, every value rendered as text (no HTML, no link built
// from data), user/client links only for valid ids, pagination keeping the filters.
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

describe("filters", () => {
  it("the form navigates with the filters as search params (no `after`) and the fn gets them", async () => {
    const router = renderAt("/audit?after=eyJ0IjoxfQ");
    await table();
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "ADMIN_USER_LOCKED" } });
    fireEvent.change(screen.getByLabelText("Result"), { target: { value: "failure" } });
    fireEvent.change(screen.getByLabelText("Target type"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("Target id"), { target: { value: ` ${USER_ID} ` } });
    fireEvent.change(screen.getByLabelText("Client id"), { target: { value: "app-1" } });
    fireEvent.change(screen.getByLabelText("From (local time)"), { target: { value: "2026-10-01T00:00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await settle();
    const s = router.state.location.search as Record<string, unknown>;
    expect(s).toEqual({
      action: "ADMIN_USER_LOCKED",
      result: "failure",
      targetType: "user",
      targetId: USER_ID,
      clientId: "app-1",
      from: new Date("2026-10-01T00:00:00").toISOString(),
    });
    expect(lastCall().data).toEqual({ limit: 20, ...s });
    expect("tenantId" in lastCall().data).toBe(false);
  });

  it("the form is filled from the URL; Clear filters empties the search", async () => {
    const from = "2026-10-01T00:00:00.000Z";
    const router = renderAt(`/audit?action=TOKEN_REUSE_DETECTED&actorId=u-1&from=${from}`);
    await table();
    expect(screen.getByLabelText<HTMLSelectElement>("Action").value).toBe("TOKEN_REUSE_DETECTED");
    expect(screen.getByLabelText<HTMLInputElement>("Actor id").value).toBe("u-1");
    expect(new Date(screen.getByLabelText<HTMLInputElement>("From (local time)").value).toISOString()).toBe(from);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await settle();
    expect(router.state.location.search).toEqual({});
    expect(lastCall().data).toEqual({ limit: 20 });
    expect(screen.getByLabelText<HTMLSelectElement>("Action").value).toBe("");
  });

  it.each([
    ["Actor id", EMAIL],
    ["Target id", EMAIL],
    ["Client id", "x@y"],
    ["Target id", "a b"],
  ])("%s %j: field error, no navigation, no request, no '@' in the URL", async (label, value) => {
    const router = renderAt("/audit");
    await table();
    const calls = list.mock.calls.length;
    const before = href(router);
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await settle();
    expect(screen.getByLabelText(label).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/no email/)).toBeTruthy();
    expect(href(router)).toBe(before);
    expect(href(router)).not.toContain("@");
    expect(href(router)).not.toContain("%40");
    expect(list.mock.calls.length).toBe(calls);
    expect(JSON.stringify(list.mock.calls)).not.toContain("@");
  });

  it("from >= to is refused before navigating", async () => {
    const router = renderAt("/audit");
    await table();
    const calls = list.mock.calls.length;
    fireEvent.change(screen.getByLabelText("From (local time)"), { target: { value: "2026-10-02T00:00:00" } });
    fireEvent.change(screen.getByLabelText("To (local time, exclusive)"), { target: { value: "2026-10-02T00:00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await settle();
    expect(screen.getByText("'To' must be after 'From'.")).toBeTruthy();
    expect(router.state.location.search).toEqual({});
    expect(list.mock.calls.length).toBe(calls);
  });

  it("junk search params are dropped, never sent (email, unknown enum, bad time, reversed range, bad cursor, tenantId)", async () => {
    renderAt(
      `/audit?actorId=${encodeURIComponent(EMAIL)}&action=DROP&result=maybe&targetType=tenant&from=yesterday` +
        "&clientId=a%20b&after=a%2Fb&tenantId=t2&targetId=ok-1",
    );
    await table();
    expect(lastCall().data).toEqual({ limit: 20, targetId: "ok-1" });
  });

  it("a reversed range in the URL drops `to`", async () => {
    renderAt("/audit?from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z");
    await table();
    expect(lastCall().data).toEqual({ limit: 20, from: "2026-10-02T00:00:00.000Z" });
  });

  it("a fixed note says sign-in/token/session events are not listed yet (except token reuse)", async () => {
    renderAt("/audit");
    await table();
    expect(screen.getByText(/Sign-in, token and session events .* except token\s+reuse/)).toBeTruthy();
  });
});

describe("table", () => {
  it("time as ISO text; IP and user agent only in the details (aria-expanded/controls)", async () => {
    renderAt("/audit");
    const [row] = await rows();
    expect(within(row!).getByText(EVENT.timestamp)).toBeTruthy();
    expect(screen.queryByText(EVENT.ip!)).toBeNull();
    const details = within(row!).getByRole("button", { name: "Details" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(details.getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(false);
    for (const text of [EVENT.ip!, EVENT.userAgent!, "req-1", "ev-1", "count", "2"]) {
      expect(within(panel).getByText(text)).toBeTruthy();
    }
    fireEvent.click(details);
    expect(screen.queryByText(EVENT.ip!)).toBeNull();
  });

  it("security events are marked with text; failure says 'Failure'; other actions are not marked", async () => {
    list.mockResolvedValue(
      page([
        { ...EVENT, eventId: "r", action: "TOKEN_REUSE_DETECTED", actorType: "client", actorId: "app-1", targetType: null, targetId: null },
        { ...EVENT, eventId: "k", action: "SIGNING_KEY_ROTATED", metadata: { mode: "emergency" } },
        { ...EVENT, eventId: "n", action: "SIGNING_KEY_ROTATED", metadata: { mode: "normal" } },
        { ...EVENT, eventId: "f", action: "ADMIN_CLIENT_UPDATED", result: "failure" },
      ]),
    );
    renderAt("/audit");
    const [reuse, emergency, normal, failure] = await rows();
    expect(within(reuse!).getByText("Security alert: token reuse")).toBeTruthy();
    expect(within(emergency!).getByText("Security alert: emergency key rotation")).toBeTruthy();
    expect(within(normal!).queryByText(/Security alert/)).toBeNull();
    expect(within(failure!).getByText("Failure")).toBeTruthy();
    expect(within(failure!).queryByText(/Security alert/)).toBeNull();
    expect(screen.getAllByText(/Security alert/)).toHaveLength(2);
  });

  it("HTML in metadata, user agent and reason is rendered as text (no new img/script)", async () => {
    const xss = '<img src=x onerror="window.__pwned=1">';
    list.mockResolvedValue(
      page([{ ...EVENT, userAgent: "<script>window.__pwned=1</script>", reason: xss, metadata: { note: xss, url: "javascript:alert(1)" } }]),
    );
    renderAt("/audit");
    const [row] = await rows();
    const imgs = document.querySelectorAll("img").length;
    const scripts = document.querySelectorAll("script").length;
    fireEvent.click(within(row!).getByRole("button", { name: "Details" }));
    expect(screen.getAllByText(xss)).toHaveLength(2);
    expect(screen.getByText("<script>window.__pwned=1</script>")).toBeTruthy();
    expect(document.querySelectorAll("img").length).toBe(imgs);
    expect(document.querySelectorAll("script").length).toBe(scripts);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    // A URL-looking value stays text: no link at all for it.
    expect(screen.getByText("javascript:alert(1)").closest("a")).toBeNull();
    for (const a of document.querySelectorAll("a")) expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
  });

  it("user and client links only for valid ids, through the app routes", async () => {
    list.mockResolvedValue(
      page([
        { ...EVENT, eventId: "ok", clientId: "app-1" },
        {
          ...EVENT,
          eventId: "bad",
          actorType: "admin",
          actorId: "javascript:alert(1)",
          targetType: "user",
          targetId: "not-a-user-id",
          clientId: "a/b",
        },
        { ...EVENT, eventId: "client-actor", actorType: "client", actorId: USER_ID, targetType: "session", targetId: USER_ID },
      ]),
    );
    renderAt("/audit");
    const [good, bad, clientActor] = await rows();
    expect(within(good!).getByRole("link", { name: ADMIN_ID }).getAttribute("href")).toBe(`/users/${ADMIN_ID}`);
    expect(within(good!).getByRole("link", { name: USER_ID }).getAttribute("href")).toBe(`/users/${USER_ID}`);
    expect(within(good!).getByRole("link", { name: "app-1" }).getAttribute("href")).toBe("/clients/app-1");
    expect(within(bad!).queryAllByRole("link")).toHaveLength(0);
    expect(within(bad!).getByText("javascript:alert(1)")).toBeTruthy();
    expect(within(bad!).getByText("not-a-user-id")).toBeTruthy();
    expect(within(bad!).getByText("a/b")).toBeTruthy();
    // A client actor or a session target is not a user, whatever its id looks like.
    expect(within(clientActor!).queryAllByRole("link")).toHaveLength(0);
  });

  it("Next keeps the filters and adds the cursor; First page drops only the cursor", async () => {
    list.mockResolvedValue(page([EVENT], "eyJuZXh0IjoxfQ"));
    const router = renderAt("/audit?action=ADMIN_USER_LOCKED&targetId=t-1");
    await table();
    fireEvent.click(screen.getByRole("link", { name: "Next page" }));
    await settle();
    expect(router.state.location.search).toEqual({ action: "ADMIN_USER_LOCKED", targetId: "t-1", after: "eyJuZXh0IjoxfQ" });
    expect(lastCall().data).toEqual({ limit: 20, action: "ADMIN_USER_LOCKED", targetId: "t-1", after: "eyJuZXh0IjoxfQ" });
    fireEvent.click(screen.getByRole("link", { name: "First page" }));
    await settle();
    expect(router.state.location.search).toEqual({ action: "ADMIN_USER_LOCKED", targetId: "t-1" });
  });

  it("empty page", async () => {
    list.mockResolvedValue(page([]));
    renderAt("/audit");
    expect(await screen.findByText("No audit events.")).toBeTruthy();
  });
});

describe("errors", () => {
  it("shows the message + Try again; invalid_request with a cursor offers First page (filters kept)", async () => {
    list.mockResolvedValue({ ok: false, error: { code: "invalid_request", message: "invalid cursor" } } as never);
    const router = renderAt("/audit?result=failure&after=eyJ0IjoxfQ");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("invalid cursor")).toBeTruthy();
    list.mockResolvedValue(page([EVENT]));
    fireEvent.click(within(alert).getByRole("link", { name: "First page" }));
    await settle();
    expect(router.state.location.search).toEqual({ result: "failure" });
    expect(await table()).toBeTruthy();
  });

  it("unavailable: no First page without a cursor; Try again re-reads", async () => {
    list.mockResolvedValueOnce({ ok: false, error: { code: "unavailable", message: "down" } } as never);
    renderAt("/audit");
    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("link")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await table()).toBeTruthy();
  });
});

describe("navigation", () => {
  it("the sidebar lists Audit log", async () => {
    renderAt("/audit");
    await table();
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Audit log" }).getAttribute("href")).toBe("/audit",
    );
  });

  it("the user page links to the audit events targeting that account (and not for an invalid id)", async () => {
    const router = renderAt(`/users/${USER_ID}`);
    const link = await screen.findByRole("link", { name: "Audit events for this account" });
    expect(link.getAttribute("href")).toBe(`/audit?targetType=user&targetId=${USER_ID}`);
    fireEvent.click(link);
    await table();
    expect(router.state.location.search).toEqual({ targetType: "user", targetId: USER_ID });
    expect(lastCall().data).toEqual({ limit: 20, targetType: "user", targetId: USER_ID });
    cleanup();
    renderAt(`/users/${encodeURIComponent(EMAIL)}`);
    await screen.findByRole("heading", { name: "User" });
    expect(screen.queryByRole("link", { name: "Audit events for this account" })).toBeNull();
  });
});
