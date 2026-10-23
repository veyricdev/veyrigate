// Run 46 tester: resources UI risk cases not covered by resources-ui.test.tsx — exact POST body at
// the field boundaries (raw identifier, 2048/2049, resourceId 64/65, scope separators), no write
// path at all for tenant_admin (list / new / detail: no control, no server fn, no step-up),
// uncertain update (DEBT-327 / case 9: the re-read data is shown, the next save is always sent),
// and the client form's resource picker re-read after a resource is created (same QueryClient).
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { listResources } from "@/features/admin-api/clients";
import { createResource, getResource, listResourcePage, updateResource } from "@/features/admin-api/resources";
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

const RES: AdminResource = { resourceId: "demo", identifier: "javascript:alert(1)", scopes: ["read", "write"] };
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
  mocks.list.mockResolvedValue(ok({ items: [RES], nextCursor: "javascript:alert(1)" }) as never);
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
const notice = () => within(form()).getAllByRole("status").at(-1)!;
const formAlert = () => within(form()).getByRole("alert");
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
const errorOf = (label: string) => {
  const id = (field(label).getAttribute("aria-describedby") ?? "").split(" ").find((i) => i.endsWith("-error"));
  return id ? (document.getElementById(id)?.textContent ?? "") : "";
};

async function fillNew(resourceId: string, identifier: string, scopes: string) {
  await screen.findByLabelText("Resource ID");
  type("Resource ID", resourceId);
  type("Identifier", identifier);
  type("Scopes", scopes);
  submit("Create resource");
}

describe("create: exact body at the boundaries", () => {
  it.each([
    ["unicode host and a query, raw (no trim / normalisation)", "https://ä.example/a?b=c", "https://ä.example/a?b=c"],
    ["empty fragment (the BE accepts it)", "https://a/#", "https://a/#"],
    ["urn:", "urn:example:api", "urn:example:api"],
    ["2048 chars", `https://a/${"x".repeat(2038)}`, `https://a/${"x".repeat(2038)}`],
  ])("%s => POST once with exactly { resourceId, identifier, scopes }", async (_, identifier, sent) => {
    mocks.create.mockResolvedValue(ok({ resourceId: "a".repeat(64), identifier: sent, scopes: [] }) as never);
    renderAt("/resources/new");
    await fillNew("a".repeat(64), identifier, " r1\tr2\n\nr3 ");
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]![0]).toEqual({
      data: { resourceId: "a".repeat(64), identifier: sent, scopes: ["r1", "r2", "r3"] },
    });
    expect(Object.keys((mocks.create.mock.calls[0]![0] as { data: object }).data).sort()).toEqual(["identifier", "resourceId", "scopes"]);
  });

  it.each([
    ["Identifier", "identifier 2049 chars", { identifier: `https://a/${"x".repeat(2039)}` }, /at most 2048/],
    ["Identifier", "fragment", { identifier: "https://a/#frag" }, /fragment/],
    ["Identifier", "trailing NBSP", { identifier: "https://a/ " }, /leading\/trailing spaces/],
    ["Identifier", "relative", { identifier: "api.example.com" }, /absolute URI/],
    ["Resource ID", "resourceId 65 chars", { resourceId: "a".repeat(65) }, /1–64 characters/],
    ["Resource ID", "resourceId starting with '-'", { resourceId: "-a" }, /1–64 characters/],
    ["Resource ID", "resourceId upper case", { resourceId: "Demo" }, /1–64 characters/],
    ["Scopes", "51 scopes", { scopes: Array.from({ length: 51 }, (_, i) => `s${i}`).join("\n") }, /At most 50/],
    ["Scopes", "a 257-char scope", { scopes: "x".repeat(257) }, /at most 256/],
    ["Scopes", "duplicate across a tab / new line", { scopes: "read\twrite\nread" }, /"read" is listed twice/],
  ])("%s: %s => field error, focused, nothing sent", async (label, _, override, message) => {
    const v = { resourceId: "demo", identifier: "https://a/", scopes: "", ...override };
    renderAt("/resources/new");
    await fillNew(v.resourceId, v.identifier, v.scopes);
    await waitFor(() => expect(errorOf(label)).toMatch(message));
    expect(field(label).getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field(label));
    await settle();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("tenant_admin: no write path at all", () => {
  beforeEach(() => vi.mocked(getViewer).mockResolvedValue(TENANT_ADMIN));

  it("list: rows readable, no New control, identifier and cursor never become a javascript: link", async () => {
    renderAt("/resources");
    expect(await screen.findByRole("link", { name: "demo" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New resource" })).toBeNull();
    expect(screen.getByText("javascript:alert(1)").closest("a")).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    expect(screen.getByRole("link", { name: "Next page" }).getAttribute("href")).toMatch(/^\/resources\?after=/);
  });

  it("/resources/new: no form, no create, no step-up; a stale draft is ignored", async () => {
    sessionStorage.setItem(
      "fea:stepup",
      JSON.stringify({ action: "resource.create", path: "/resources/new", sub: "u1", payload: { resourceId: "x", identifier: "https://a/", scopes: "" } }),
    );
    renderAt("/resources/new");
    expect(await screen.findByText("Only a super_admin can create resources.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create resource" })).toBeNull();
    expect(document.querySelector("form[novalidate]")).toBeNull();
    await settle();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("detail: identifier text, scopes text, no input / textarea / submit, no update", async () => {
    renderAt("/resources/demo");
    expect(await screen.findByText("read write")).toBeTruthy();
    expect(screen.getByText("javascript:alert(1)").closest("a")).toBeNull();
    expect(document.querySelector("main input, main textarea, main button[type=submit]")).toBeNull();
    await settle();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("uncertain update (DEBT-327)", () => {
  async function uncertainThenServerHas(scopes: string[], typed = scopes.join(" ")) {
    renderAt("/resources/demo");
    await waitFor(() => expect(field("Scopes").value).toBe("read write"));
    mocks.update.mockResolvedValueOnce(fail("unavailable", "x", true) as never);
    mocks.get.mockResolvedValue(ok({ ...RES, scopes }) as never); // the write did land
    type("Scopes", typed);
    submit("Save scopes");
    await waitFor(() => expect(formAlert().textContent).toMatch(/result is unknown/));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(1));
    await settle();
  }

  it("DEBT-327: the re-read scopes are shown read-only beside the form; the admin's draft is kept", async () => {
    // Re-read returns a value different from the admin's text (e.g. a concurrent edit, DEBT-323).
    await uncertainThenServerHas(["server-saved"], "mine");
    expect(formAlert().textContent).toMatch(/saved scopes are shown below the form; saving again sends your values/);
    expect(document.body.textContent).toMatch(/Currently saved: server-saved/);
    expect(field("Scopes").value).toBe("mine"); // never overwritten by the refetch
    expect(mocks.update).toHaveBeenCalledTimes(1); // never re-sent by itself
  });

  // Case 9 (intent reversal, fixed): the uncertain PATCH did land (server = ["admin"]); the admin
  // reverts to the original "read write". The mount base would answer "No changes to save."; after
  // an unknown outcome the next save is always sent.
  it("after an uncertain update that landed, reverting to the original scopes is sent (not 'No changes')", async () => {
    await uncertainThenServerHas(["admin"]);
    mocks.update.mockResolvedValue(ok(RES) as never);
    type("Scopes", "read write");
    submit("Save scopes");
    await settle();
    expect(notice().textContent).not.toBe("No changes to save.");
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[1]![0]).toEqual({ data: { resourceId: "demo", patch: { scopes: ["read", "write"] } } });
    expect(document.body.textContent).not.toMatch(/Currently saved:/); // confirmed: the base is known again
    type("Scopes", "read  write");
    submit("Save scopes");
    await settle();
    expect(notice().textContent).toBe("No changes to save.");
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });
});

describe("client form resource picker after a resource write", () => {
  it("creating a resource re-reads the picker options: /clients/new then lists it (same QueryClient)", async () => {
    const NEW: AdminResource = { resourceId: "fresh-api", identifier: "https://fresh.example/", scopes: [] };
    mocks.options.mockResolvedValue(ok([{ resourceId: "demo", identifier: "https://api.example.com/", adminCapable: false }]) as never);
    const router = renderAt("/clients/new");
    expect(await screen.findByRole("checkbox", { name: /demo/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /fresh-api/ })).toBeNull();

    mocks.create.mockResolvedValue(ok(NEW) as never);
    mocks.get.mockResolvedValue(ok(NEW) as never);
    mocks.options.mockResolvedValue(
      ok([
        { resourceId: "demo", identifier: "https://api.example.com/", adminCapable: false },
        { resourceId: "fresh-api", identifier: "https://fresh.example/", adminCapable: false },
      ]) as never,
    );
    await act(() => router.navigate({ to: "/resources/new" }));
    await fillNew("fresh-api", "https://fresh.example/", "");
    await waitFor(() => expect(router.state.location.pathname).toBe("/resources/fresh-api"));
    await act(() => router.navigate({ to: "/clients/new" }));
    expect(await screen.findByRole("checkbox", { name: /fresh-api/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /demo/ })).toBeTruthy();
  });
});

// Tester run 46 round 2: the `unsure` flag (case 9 fix) across failure sequences. The invariant:
// after any unknown outcome, the next save is sent with exactly the admin's values, until a save is
// confirmed; a 4xx in between does not make the server value known again.
describe("uncertain update: failure sequences (case 9, round 2)", () => {
  const lastPatch = () => mocks.update.mock.calls.at(-1)![0];
  const sentScopes = (scopes: string[]) => ({ data: { resourceId: "demo", patch: { scopes } } });
  const uncertain = () => fail("unavailable", "x", true) as never;

  async function open() {
    renderAt("/resources/demo");
    await waitFor(() => expect(field("Scopes").value).toBe("read write"));
  }
  async function save(scopes: string, expectAlert: RegExp) {
    type("Scopes", scopes);
    submit("Save scopes");
    await waitFor(() => expect(formAlert().textContent).toMatch(expectAlert));
    await settle();
  }

  it("uncertain twice in a row, then revert to the mount value: sent each time, never 'No changes'", async () => {
    await open();
    mocks.update.mockResolvedValueOnce(uncertain()).mockResolvedValueOnce(uncertain());
    mocks.get.mockResolvedValue(ok({ ...RES, scopes: ["admin"] }) as never);
    await save("admin", /result is unknown/);
    await save("admin", /result is unknown/);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(lastPatch()).toEqual(sentScopes(["admin"]));
    mocks.update.mockResolvedValue(ok(RES) as never);
    type("Scopes", "read write");
    submit("Save scopes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(3));
    expect(lastPatch()).toEqual(sentScopes(["read", "write"]));
  });

  it("uncertain, then a 4xx (not uncertain), then save again: still sent (the 4xx proves nothing)", async () => {
    await open();
    mocks.update
      .mockResolvedValueOnce(uncertain())
      .mockResolvedValueOnce(fail("invalid_request", "scope rejected") as never);
    mocks.get.mockResolvedValue(ok({ ...RES, scopes: ["admin"] }) as never);
    await save("admin", /result is unknown/);
    await save("read write", /scope rejected/);
    expect(document.body.textContent).toMatch(/Currently saved: admin/); // still unsure
    mocks.update.mockResolvedValue(ok(RES) as never);
    submit("Save scopes"); // same "read write" again: equals the mount base, must still be sent
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(3));
    expect(lastPatch()).toEqual(sentScopes(["read", "write"]));
    await settle();
    expect(document.body.textContent).not.toMatch(/Currently saved:/);
  });

  it("a thrown error (network / BFF), then revert to the mount value: sent", async () => {
    await open();
    mocks.update.mockRejectedValueOnce(new Error("socket hang up"));
    mocks.get.mockResolvedValue(ok({ ...RES, scopes: ["admin"] }) as never);
    await save("admin", /Something went wrong/);
    mocks.update.mockResolvedValue(ok(RES) as never);
    type("Scopes", "read write");
    submit("Save scopes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(lastPatch()).toEqual(sentScopes(["read", "write"]));
  });

  it("uncertain that did NOT land: saving again re-sends exactly the same value; a confirmed save re-enables 'No changes'", async () => {
    await open();
    mocks.update.mockResolvedValueOnce(uncertain());
    // the re-read shows the write did not land: server still has the mount value
    await save("admin  write", /result is unknown/);
    expect(document.body.textContent).toMatch(/Currently saved: read write/);
    expect(field("Scopes").value).toBe("admin  write"); // the draft is never replaced by the re-read
    mocks.update.mockResolvedValue(ok({ ...RES, scopes: ["admin", "write"] }) as never);
    submit("Save scopes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(lastPatch()).toEqual(sentScopes(["admin", "write"]));
    await settle();
    submit("Save scopes");
    await settle();
    expect(notice().textContent).toBe("No changes to save.");
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it("a refetch while unsure (window focus) never overwrites the draft", async () => {
    await open();
    mocks.update.mockResolvedValueOnce(uncertain());
    mocks.get.mockResolvedValue(ok({ ...RES, scopes: ["other"] }) as never);
    await save("mine", /result is unknown/);
    const calls = mocks.get.mock.calls.length;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(calls));
    await settle();
    expect(field("Scopes").value).toBe("mine");
    expect(document.body.textContent).toMatch(/Currently saved: other/);
  });

  // DEBT-332 characterisation (senior round 2). In-flight half: the mutation's onSettled returns the
  // invalidation promise, so the outcome (and the "Currently saved" line) waits for the re-read: the
  // pre-save cache is never shown under that label while the re-read is in flight.
  it("DEBT-332: re-read in flight => no outcome and no 'Currently saved' until it resolves, then the re-read value", async () => {
    await open();
    let release!: (v: unknown) => void;
    mocks.get.mockImplementation(() => new Promise((r) => (release = r)) as never);
    mocks.update.mockResolvedValueOnce(uncertain());
    type("Scopes", "admin");
    submit("Save scopes");
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(1));
    await settle();
    expect(document.body.textContent).not.toMatch(/Currently saved:/);
    expect(formAlert().textContent).toBe(""); // the region is always rendered (DEBT-319), still empty
    await act(async () => release(ok({ ...RES, scopes: ["admin"] })));
    await waitFor(() => expect(formAlert().textContent).toMatch(/result is unknown/));
    expect(document.body.textContent).toMatch(/Currently saved: admin/);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  // Failed half (reproduces DEBT-332): the re-read fails, TanStack keeps the pre-save data, and the
  // line labels it "Currently saved" next to the load-error alert. Not an intent reversal: the next
  // save is still sent with the admin's values.
  it("DEBT-332: re-read failed => error alert AND 'Currently saved' with the stale cache", async () => {
    await open();
    mocks.get.mockResolvedValue(fail("unavailable", "down") as never);
    mocks.update.mockResolvedValueOnce(uncertain());
    await save("admin", /result is unknown/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
    expect(document.body.textContent).toMatch(/Currently saved: read write/); // stale: server may have "admin"
    expect(field("Scopes").value).toBe("admin");
    mocks.update.mockResolvedValue(ok(RES) as never);
    type("Scopes", "read write");
    submit("Save scopes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(lastPatch()).toEqual(sentScopes(["read", "write"]));
  });
});
