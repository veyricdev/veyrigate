// Resources UI (run 46 A6.2): list (cursor pages, identifier as text only), create form (zod
// mirror of the BE rules, field errors + a11y, BE errors, uncertain, step-up round-trip without
// auto-submit), detail (immutable facts as text, PATCH `{ scopes }` only when changed, frozen base),
// super_admin-only write UI. Real route tree (memory history) under StrictMode; server fns mocked.
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider, focusManager, useQueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { listResources } from "@/features/admin-api/clients";
import { createResource, getResource, listResourcePage, updateResource } from "@/features/admin-api/resources";
import { useResources, useUpdateResource } from "@/features/admin-api/hooks";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AdminApiErrorCode } from "@/features/admin-api/types";
import type { AdminResource } from "@/server/admin-api/schemas";

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

const mocks = {
  list: vi.mocked(listResourcePage),
  get: vi.mocked(getResource),
  create: vi.mocked(createResource),
  update: vi.mocked(updateResource),
  options: vi.mocked(listResources),
};
const KEY = "fea:stepup";

const RES: AdminResource = { resourceId: "demo", identifier: "https://api.example.com/", scopes: ["read", "write"] };
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: AdminApiErrorCode, message = "m", uncertain = false) => ({
  ok: false as const,
  error: { code, message, ...(uncertain ? { uncertain: true as const } : {}) },
});
const SUPER = { sub: "u1", email: "admin@example.com", roles: ["super_admin"], tenantId: "t1" };
const TENANT_ADMIN = { ...SUPER, roles: ["tenant_admin"] };

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue(SUPER);
  mocks.list.mockResolvedValue(ok({ items: [RES], nextCursor: null }) as never);
  mocks.get.mockResolvedValue(ok(RES) as never);
  mocks.options.mockResolvedValue(ok([]) as never);
});
afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderAt(path: string) {
  const queryClient = createQueryClient();
  queryClient.setQueryDefaults(["admin"], { retry: false });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    Wrap: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  return router;
}

const field = (label: string) => screen.getByLabelText(label) as HTMLTextAreaElement | HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const submit = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const form = () => document.querySelector("form[novalidate]") as HTMLElement;
/** The form's always-rendered result region (not the restored banner). */
const notice = () => within(form()).getAllByRole("status").at(-1)!;
const formAlert = () => within(form()).getByRole("alert");
const describedErrors = (el: HTMLElement) =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id.endsWith("-error"))
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
const noScriptLinks = () => expect(document.querySelector('a[href^="javascript"]')).toBeNull();

describe("resources list", () => {
  it("semantic table; identifier is text (javascript: never a link); the id links to the detail", async () => {
    mocks.list.mockResolvedValue(ok({ items: [{ ...RES, identifier: "javascript:alert(1)" }], nextCursor: null }) as never);
    renderAt("/resources");
    const table = await screen.findByRole("table", { name: "Resources" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Resource ID", "Identifier", "Scopes"]);
    const cell = within(table).getByText("javascript:alert(1)");
    expect(cell.closest("a")).toBeNull();
    noScriptLinks();
    expect(within(table).getByRole("link", { name: "demo" }).getAttribute("href")).toBe("/resources/demo");
    expect(within(table).getByText("read write")).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith({ data: { limit: 20 } });
  });

  it("next page uses ?after=<nextCursor>; first page goes back without a cursor", async () => {
    mocks.list.mockResolvedValue(ok({ items: [RES], nextCursor: "https://api.example.com/" }) as never);
    const router = renderAt("/resources");
    fireEvent.click(await screen.findByRole("link", { name: "Next page" }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ data: { limit: 20, after: "https://api.example.com/" } }));
    expect(router.state.location.search).toEqual({ after: "https://api.example.com/" });
    expect(await screen.findByRole("table", { name: "Resources (next page)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "First page" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it("empty state", async () => {
    mocks.list.mockResolvedValue(ok({ items: [], nextCursor: null }) as never);
    renderAt("/resources");
    expect(await screen.findByText("No resources yet.")).toBeTruthy();
  });

  it("error state: alert with the fixed message, retry refetches", async () => {
    mocks.list.mockResolvedValue(fail("unavailable", "The admin service is temporarily unavailable.") as never);
    renderAt("/resources");
    expect((await screen.findByRole("alert")).textContent).toMatch(/temporarily unavailable/);
    mocks.list.mockResolvedValue(ok({ items: [RES], nextCursor: null }) as never);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Resources" })).toBeTruthy();
  });

  it("New resource only for a super_admin; the sidebar links to /resources", async () => {
    renderAt("/resources");
    expect(await screen.findByRole("link", { name: "New resource" })).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Resources" })).toBeTruthy();
    cleanup();
    vi.mocked(getViewer).mockResolvedValue(TENANT_ADMIN);
    renderAt("/resources");
    await screen.findByRole("table", { name: "Resources" });
    expect(screen.queryByRole("link", { name: "New resource" })).toBeNull();
  });
});

describe("new resource", () => {
  it("each field error is attached to its field; first invalid field focused; nothing sent", async () => {
    renderAt("/resources/new");
    await screen.findByLabelText("Resource ID");
    type("Resource ID", "Demo");
    type("Identifier", " https://a/");
    type("Scopes", "read read");
    submit("Create resource");
    await waitFor(() => expect(field("Resource ID").getAttribute("aria-invalid")).toBe("true"));
    expect(document.activeElement).toBe(field("Resource ID"));
    expect(describedErrors(field("Resource ID"))).toMatch(/lowercase/);
    expect(describedErrors(field("Identifier"))).toBe("Remove leading/trailing spaces");
    expect(describedErrors(field("Scopes"))).toBe('"read" is listed twice');
    expect(field("Identifier").getAttribute("aria-describedby")).toContain("resource-identifier-hint");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ["https://api.example.com/#frag", "Must not contain a fragment"],
    ["https://api.example.com/ ", "Remove leading/trailing spaces"],
    ["api.example.com", "Must be an absolute URI"],
  ])("identifier %j blocked: %s", async (identifier, message) => {
    renderAt("/resources/new");
    await screen.findByLabelText("Resource ID");
    type("Resource ID", "demo");
    type("Identifier", identifier);
    submit("Create resource");
    await waitFor(() => expect(describedErrors(field("Identifier"))).toBe(message));
    expect(document.activeElement).toBe(field("Identifier"));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("51 scopes blocked, 50 sent; success => exact body, detail page", async () => {
    mocks.create.mockResolvedValue(ok({ ...RES, resourceId: "new-1" }) as never);
    const router = renderAt("/resources/new");
    await screen.findByLabelText("Resource ID");
    type("Resource ID", "new-1");
    type("Identifier", "urn:example:api");
    const scopes = Array.from({ length: 51 }, (_, i) => `s${i}`);
    type("Scopes", scopes.join("\n"));
    submit("Create resource");
    await waitFor(() => expect(describedErrors(field("Scopes"))).toBe("At most 50 scopes"));
    expect(mocks.create).not.toHaveBeenCalled();
    type("Scopes", scopes.slice(0, 50).join(" "));
    submit("Create resource");
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]![0]).toEqual({
      data: { resourceId: "new-1", identifier: "urn:example:api", scopes: scopes.slice(0, 50) },
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/resources/new-1"));
  });

  it.each([
    ["invalid_request", "resource must be an absolute URI: x"],
    ["conflict", "Resource already exists"],
    ["forbidden", "You do not have permission to do this."],
  ] as const)("%s => form-level alert with the text (no link)", async (code, message) => {
    mocks.create.mockResolvedValue(fail(code, message) as never);
    renderAt("/resources/new");
    await screen.findByLabelText("Resource ID");
    type("Resource ID", "demo");
    type("Identifier", "https://api.example.com/");
    submit("Create resource");
    await waitFor(() => expect(formAlert().textContent).toBe(message));
    expect(formAlert().innerHTML).not.toContain("<a");
  });

  it("uncertain => 'may have been created', never re-sent", async () => {
    mocks.create.mockResolvedValue(fail("unavailable", "x", true) as never);
    renderAt("/resources/new");
    await screen.findByLabelText("Resource ID");
    type("Resource ID", "demo");
    type("Identifier", "https://api.example.com/");
    submit("Create resource");
    await waitFor(() => expect(formAlert().textContent).toMatch(/may have been created.*already exists/));
    await settle();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("submit disabled while pending: a double click sends once", async () => {
    let resolve!: (v: unknown) => void;
    mocks.create.mockReturnValue(new Promise((r) => (resolve = r)) as never);
    const router = renderAt("/resources/new");
    await screen.findByLabelText("Resource ID");
    type("Resource ID", "demo");
    type("Identifier", "https://api.example.com/");
    submit("Create resource");
    await waitFor(() => expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await act(async () => resolve(ok(RES)));
    await waitFor(() => expect(router.state.location.pathname).toBe("/resources/demo"));
  });

  it("step_up_required => draft + re-auth; back: restored, NOT sent, submit sends once", async () => {
    mocks.create.mockResolvedValueOnce(fail("step_up_required") as never);
    renderAt("/resources/new");
    await screen.findByLabelText("Resource ID");
    type("Resource ID", "demo");
    type("Identifier", "https://api.example.com/");
    type("Scopes", "read write");
    submit("Create resource");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/auth/login?stepup=1&returnTo=%2Fresources%2Fnew"));
    const stored = JSON.parse(sessionStorage.getItem(KEY)!);
    expect(stored).toMatchObject({
      action: "resource.create",
      path: "/resources/new",
      sub: "u1",
      payload: { resourceId: "demo", identifier: "https://api.example.com/", scopes: "read write" },
    });
    expect(Object.keys(stored.payload).sort()).toEqual(["identifier", "resourceId", "scopes"]);
    cleanup();

    mocks.create.mockResolvedValue(ok(RES) as never);
    renderAt("/resources/new");
    await waitFor(() => expect(field("Identifier").value).toBe("https://api.example.com/"));
    expect(within(form()).getAllByRole("status")[0]!.textContent).toMatch(/submit again/);
    expect(field("Resource ID").value).toBe("demo");
    expect(sessionStorage.getItem(KEY)).toBeNull();
    await settle();
    expect(mocks.create).toHaveBeenCalledTimes(1); // only the refused one
    submit("Create resource");
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.create.mock.calls[1]![0]).toEqual({
      data: { resourceId: "demo", identifier: "https://api.example.com/", scopes: ["read", "write"] },
    });
  });

  it("tenant_admin: no form, no create call", async () => {
    vi.mocked(getViewer).mockResolvedValue(TENANT_ADMIN);
    renderAt("/resources/new");
    expect(await screen.findByText("Only a super_admin can create resources.")).toBeTruthy();
    expect(screen.queryByLabelText("Resource ID")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create resource" })).toBeNull();
    await settle();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("resource detail", () => {
  it("identifier and id are text (no control, javascript: never a link); no change => no request; PATCH is { scopes } only", async () => {
    mocks.get.mockResolvedValue(ok({ ...RES, identifier: "javascript:alert(1)" }) as never);
    mocks.update.mockResolvedValue(ok({ ...RES, identifier: "javascript:alert(1)", scopes: ["read"] }) as never);
    renderAt("/resources/demo");
    await screen.findByLabelText("Scopes");
    expect(screen.getByText("javascript:alert(1)").tagName).toBe("DD");
    noScriptLinks();
    expect(screen.queryByLabelText("Identifier")).toBeNull();
    expect(screen.queryByLabelText("Resource ID")).toBeNull();
    expect(within(form()).queryAllByRole("textbox")).toHaveLength(1);
    expect(field("Scopes").value).toBe("read write");
    expect(screen.getByText(/token scopes are bounded by each client's scopes/)).toBeTruthy();

    type("Scopes", " read\nwrite ");
    submit("Save scopes");
    await waitFor(() => expect(notice().textContent).toBe("No changes to save."));
    expect(mocks.update).not.toHaveBeenCalled();

    type("Scopes", "read");
    submit("Save scopes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]![0]).toEqual({ data: { resourceId: "demo", patch: { scopes: ["read"] } } });
    expect(Object.keys((mocks.update.mock.calls[0]![0] as { data: { patch: object } }).data.patch)).toEqual(["scopes"]);
    await waitFor(() => expect(notice().textContent).toBe("Saved."));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Scopes" })));
  });

  it("reordering is a change; an empty list is sent as []", async () => {
    mocks.update
      .mockResolvedValueOnce(ok({ ...RES, scopes: ["write", "read"] }) as never)
      .mockResolvedValueOnce(ok({ ...RES, scopes: [] }) as never);
    renderAt("/resources/demo");
    await screen.findByLabelText("Scopes");
    type("Scopes", "write read");
    submit("Save scopes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]![0]).toEqual({ data: { resourceId: "demo", patch: { scopes: ["write", "read"] } } });
    type("Scopes", "");
    submit("Save scopes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[1]![0]).toEqual({ data: { resourceId: "demo", patch: { scopes: [] } } });
  });

  it("result regions exist before the submit and are filled after it", async () => {
    mocks.update.mockResolvedValue(fail("forbidden", "You do not have permission to do this.") as never);
    renderAt("/resources/demo");
    await screen.findByLabelText("Scopes");
    expect(notice().textContent).toBe("");
    expect(formAlert().textContent).toBe("");
    type("Scopes", "read");
    submit("Save scopes");
    await waitFor(() => expect(formAlert().textContent).toBe("You do not have permission to do this."));
  });

  it("uncertain update => message, detail re-read (not re-sent)", async () => {
    mocks.update.mockResolvedValue(fail("unavailable", "x", true) as never);
    renderAt("/resources/demo");
    await screen.findByLabelText("Scopes");
    type("Scopes", "read");
    const reads = mocks.get.mock.calls.length;
    submit("Save scopes");
    await waitFor(() => expect(formAlert().textContent).toMatch(/result is unknown/));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(reads));
    await settle();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("a refetch while editing never overwrites the edit; the diff base stays the loaded data", async () => {
    mocks.update.mockResolvedValue(ok(RES) as never);
    renderAt("/resources/demo");
    await screen.findByLabelText("Scopes");
    type("Scopes", "read write admin");
    mocks.get.mockResolvedValue(ok({ ...RES, scopes: ["other"] }) as never);
    const reads = mocks.get.mock.calls.length;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(reads));
    await settle();
    expect(field("Scopes").value).toBe("read write admin");
    submit("Save scopes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]![0]).toEqual({ data: { resourceId: "demo", patch: { scopes: ["read", "write", "admin"] } } });
  });

  it("step_up_required => draft { scopes } + re-auth; back: restored, NOT sent, submit sends once", async () => {
    mocks.update.mockResolvedValueOnce(fail("step_up_required") as never);
    renderAt("/resources/demo");
    await screen.findByLabelText("Scopes");
    type("Scopes", "read admin");
    submit("Save scopes");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/auth/login?stepup=1&returnTo=%2Fresources%2Fdemo"));
    const stored = JSON.parse(sessionStorage.getItem(KEY)!);
    expect(stored).toMatchObject({ action: "resource.update", path: "/resources/demo", sub: "u1" });
    expect(stored.payload).toEqual({ scopes: "read admin" });
    cleanup();

    mocks.update.mockResolvedValue(ok({ ...RES, scopes: ["read", "admin"] }) as never);
    renderAt("/resources/demo");
    await waitFor(() => expect(field("Scopes").value).toBe("read admin"));
    expect(within(form()).getAllByRole("status")[0]!.textContent).toMatch(/submit again/);
    await settle();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    submit("Save scopes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[1]![0]).toEqual({ data: { resourceId: "demo", patch: { scopes: ["read", "admin"] } } });
  });

  it("not found => message", async () => {
    mocks.get.mockResolvedValue(fail("not_found") as never);
    renderAt("/resources/nope");
    expect((await screen.findByRole("alert")).textContent).toMatch(/This resource does not exist/);
  });

  it("tenant_admin: scopes as text, no form", async () => {
    vi.mocked(getViewer).mockResolvedValue(TENANT_ADMIN);
    renderAt("/resources/demo");
    expect(await screen.findByText("read write")).toBeTruthy();
    expect(screen.queryByLabelText("Scopes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save scopes" })).toBeNull();
    expect(screen.getByText("Only a super_admin can change them.")).toBeTruthy();
  });

  it("switching to another resource (cached) remounts: A's unsaved edit and base never reach B", async () => {
    const B = { resourceId: "other", identifier: "urn:other", scopes: ["b1"] };
    mocks.get.mockImplementation((async ({ data }: { data: string }) => ok(data === "other" ? B : RES)) as never);
    mocks.update.mockResolvedValue(ok(B) as never);
    const router = renderAt("/resources/other");
    await waitFor(() => expect(field("Scopes").value).toBe("b1"));
    await act(() => router.navigate({ to: "/resources/$resourceId", params: { resourceId: "demo" } }));
    await waitFor(() => expect(field("Scopes").value).toBe("read write"));
    type("Scopes", "unsaved-of-demo");
    await act(() => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/resources/other"));
    await settle();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("other");
    expect(field("Scopes").value).toBe("b1");
    submit("Save scopes");
    await waitFor(() => expect(notice().textContent).toBe("No changes to save."));
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("invalidation", () => {
  it("a resource write (also uncertain / a throw) re-reads the client form's resource options", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryDefaults(["admin"], { retry: false });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => ({ options: useResources(), update: useUpdateResource(), qc: useQueryClient() }), { wrapper });
    await waitFor(() => expect(result.current.options.isSuccess).toBe(true));
    const input = { resourceId: "demo", patch: { scopes: [] } };
    for (const [answer, reads] of [
      [() => Promise.resolve(ok(RES)), 2],
      [() => Promise.resolve(fail("unavailable", "x", true)), 3],
      [() => Promise.reject(new TypeError("fetch failed")), 4],
      [() => Promise.resolve(fail("forbidden")), 4], // a known refusal changed nothing
    ] as const) {
      mocks.update.mockImplementationOnce(answer as never);
      await act(() => result.current.update.mutateAsync(input).catch(() => undefined));
      await waitFor(() => expect(mocks.options).toHaveBeenCalledTimes(reads));
    }
    await settle();
    expect(mocks.options).toHaveBeenCalledTimes(4);
  });
});
