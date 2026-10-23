// Clients UI (run 44 A6.1): list (cursor pages), open by id, create/edit form (zod mirror of the
// BE rules, field errors + a11y, form-level BE errors, step-up round-trip without auto-submit),
// rendered through the real route tree (memory history) under StrictMode. Server fns are mocked.
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { createClient, getClient, listClients, listResources, updateClient } from "@/features/admin-api/clients";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AdminApiErrorCode } from "@/features/admin-api/types";
import type { AdminClient } from "@/server/admin-api/schemas";
import { ORIGIN_CASES, REDIRECT_CASES } from "./support/uri-cases";

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
// Detail pages of a confidential client also list its secrets (run 45): empty by default.
vi.mock("@/features/admin-api/secrets", () => ({
  listSecrets: vi.fn(async () => ({ ok: true, data: { items: [] } })),
  issueSecret: vi.fn(),
  revokeSecret: vi.fn(),
}));

const mocks = {
  list: vi.mocked(listClients),
  get: vi.mocked(getClient),
  create: vi.mocked(createClient),
  update: vi.mocked(updateClient),
  resources: vi.mocked(listResources),
};
const KEY = "fea:stepup";

const CLIENT: AdminClient = {
  clientId: "app-1",
  tenantId: "t1",
  clientType: "confidential",
  tokenEndpointAuthMethod: "client_secret_basic",
  grantTypes: ["authorization_code"],
  redirectUris: ["https://app.example/cb"],
  postLogoutRedirectUris: [],
  frontchannelLogoutUri: null,
  allowedCorsOrigins: [],
  allowedResources: [],
  scopes: ["openid"],
  disabled: false,
  disabledAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: null,
};
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: AdminApiErrorCode, message = "m", uncertain = false) => ({
  ok: false as const,
  error: { code, message, ...(uncertain ? { uncertain: true as const } : {}) },
});

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue({ sub: "u1", email: "admin@example.com", roles: ["super_admin"], tenantId: "t1" });
  mocks.list.mockResolvedValue(ok({ items: [CLIENT], nextCursor: null }) as never);
  mocks.get.mockResolvedValue(ok(CLIENT) as never);
  mocks.resources.mockResolvedValue(
    ok([
      { resourceId: "admin", identifier: "http://idp.test/admin/", scopes: [], adminCapable: true },
      { resourceId: "demo", identifier: "http://idp.test/demo/", scopes: [], adminCapable: false },
    ]) as never,
  );
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

/** The tab gets the focus back => the detail query refetches (what a real browser does). */
async function refocusAndRefetch() {
  const reads = mocks.get.mock.calls.length;
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(reads));
  await act(() => new Promise((r) => setTimeout(r, 30)));
}

const field = (label: string) => screen.getByLabelText(label) as HTMLTextAreaElement | HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const submit = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
/** Error text that `aria-describedby` of the control points to. */
const describedErrors = (el: HTMLElement) =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id.endsWith("-error"))
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

describe("clients list", () => {
  it("renders a semantic table; URIs are plain text, never links", async () => {
    mocks.list.mockResolvedValue(
      ok({ items: [{ ...CLIENT, redirectUris: ["javascript:alert(1)", "https://b.example/cb"] }], nextCursor: null }) as never,
    );
    renderAt("/clients");
    const table = await screen.findByRole("table", { name: "Clients" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Client ID",
      "Type",
      "Auth method",
      "Redirect URIs",
      "Status",
    ]);
    expect(within(table).getByRole("link", { name: "app-1" }).getAttribute("href")).toBe("/clients/app-1");
    expect(table.textContent).toContain("javascript:alert(1)");
    expect([...document.querySelectorAll("a")].some((a) => /javascript:/i.test(a.getAttribute("href") ?? ""))).toBe(false);
    expect(mocks.list).toHaveBeenCalledWith({ data: { limit: 20 } });
    expect(screen.queryByRole("link", { name: "Next page" })).toBeNull();
    expect(screen.queryByRole("link", { name: "First page" })).toBeNull();
  });

  it("next page uses ?after=<nextCursor>; first page goes back without a cursor", async () => {
    mocks.list.mockImplementation((async ({ data }: { data: { after?: string } }) =>
      data.after
        ? ok({ items: [{ ...CLIENT, clientId: "app-9" }], nextCursor: null })
        : ok({ items: [CLIENT], nextCursor: "app-1" })) as never);
    const router = renderAt("/clients");
    fireEvent.click(await screen.findByRole("link", { name: "Next page" }));
    expect(await screen.findByRole("link", { name: "app-9" })).toBeTruthy();
    expect(router.state.location.search).toEqual({ after: "app-1" });
    expect(mocks.list).toHaveBeenLastCalledWith({ data: { limit: 20, after: "app-1" } });
    fireEvent.click(screen.getByRole("link", { name: "First page" }));
    expect(await screen.findByRole("link", { name: "app-1" })).toBeTruthy();
    expect(router.state.location.search).toEqual({});
  });

  it("empty state", async () => {
    mocks.list.mockResolvedValue(ok({ items: [], nextCursor: null }) as never);
    renderAt("/clients");
    expect(await screen.findByText("No clients yet.")).toBeTruthy();
  });

  it("error state: alert with the fixed message, retry refetches", async () => {
    mocks.list.mockResolvedValueOnce(fail("forbidden", "You do not have permission to do this.") as never);
    renderAt("/clients");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("You do not have permission to do this.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "app-1" })).toBeTruthy();
  });

  it("open by client id: invalid => field error, valid => detail page", async () => {
    const router = renderAt("/clients");
    await screen.findByRole("table");
    type("Client ID", "a/b");
    submit("Open");
    expect(field("Client ID").getAttribute("aria-invalid")).toBe("true");
    expect(describedErrors(field("Client ID"))).toMatch(/valid client ID/);
    type("Client ID", "app-1");
    submit("Open");
    await waitFor(() => expect(router.state.location.pathname).toBe("/clients/app-1"));
    expect(mocks.get).toHaveBeenCalledWith({ data: "app-1" });
  });
});

describe("create form", () => {
  it("type/method: only valid pairs; changing the type resets the method", async () => {
    renderAt("/clients/new");
    await screen.findByLabelText("Redirect URIs");
    const methods = () =>
      within(screen.getByRole("group", { name: "Token endpoint auth method" }))
        .getAllByRole("radio")
        .map((r) => [r.parentElement!.textContent, (r as HTMLInputElement).checked]);
    expect(methods()).toEqual([
      ["client_secret_basic", true],
      ["client_secret_post", false],
    ]);
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    expect(methods()).toEqual([["none", true]]);
    fireEvent.click(screen.getByRole("radio", { name: /Confidential/ }));
    fireEvent.click(screen.getByRole("radio", { name: "client_secret_post" }));
    type("Redirect URIs", "https://app.example/cb");
    mocks.create.mockResolvedValue(ok({ ...CLIENT, clientId: "new-1" }) as never);
    submit("Create client");
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]![0]).toEqual({
      data: {
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        grantTypes: ["authorization_code"],
        redirectUris: ["https://app.example/cb"],
        postLogoutRedirectUris: [],
        allowedCorsOrigins: [],
        allowedResources: [],
        scopes: [],
      },
    });
  });

  it.each(REDIRECT_CASES.filter(([, e]) => e))("redirect URI %j => field error, nothing sent", async (value, expected) => {
    renderAt("/clients/new");
    await screen.findByLabelText("Redirect URIs");
    type("Redirect URIs", `https://ok.example/cb\n${value}`);
    submit("Create client");
    await waitFor(() => expect(field("Redirect URIs").getAttribute("aria-invalid")).toBe("true"));
    expect(describedErrors(field("Redirect URIs"))).toMatch(new RegExp(`Line 2: .*${expected!.source}`));
    expect(document.activeElement).toBe(field("Redirect URIs"));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(ORIGIN_CASES.filter(([, e]) => e))("CORS origin %j => field error", async (value, expected) => {
    renderAt("/clients/new");
    await screen.findByLabelText("Allowed CORS origins");
    type("Allowed CORS origins", value);
    submit("Create client");
    await waitFor(() => expect(describedErrors(field("Allowed CORS origins"))).toMatch(expected!));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("a11y: labels, hint linked, http://localhost warning (not blocking), error cleared on fix", async () => {
    renderAt("/clients/new");
    const uris = await screen.findByLabelText("Redirect URIs");
    expect(uris.getAttribute("aria-invalid")).toBe("false");
    expect(uris.getAttribute("aria-describedby")).toBe("client-redirectUris-hint");
    type("Redirect URIs", "http://localhost:3000/cb");
    expect(uris.getAttribute("aria-describedby")).toContain("client-redirectUris-warning");
    expect(document.getElementById("client-redirectUris-warning")!.textContent).toMatch(/outside production/);
    type("Allowed CORS origins", "https://app.example/");
    submit("Create client");
    await waitFor(() => expect(field("Allowed CORS origins").getAttribute("aria-invalid")).toBe("true"));
    expect(document.activeElement).toBe(field("Allowed CORS origins")); // first invalid field
    type("Allowed CORS origins", "https://app.example");
    await waitFor(() => expect(field("Allowed CORS origins").getAttribute("aria-invalid")).toBe("false"));
  });

  it("admin-capable resource carries the warning label (display only, still selectable)", async () => {
    renderAt("/clients/new");
    const admin = await screen.findByRole("checkbox", { name: /^admin/ });
    expect(admin.closest("label")!.textContent).toMatch(/super_admin only.*confidential.*revokes every existing secret/);
    expect((admin as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole("checkbox", { name: /^demo/ }).closest("label")!.textContent).not.toMatch(/super_admin/);
  });

  it.each([
    ["invalid_request", "redirect_uri must not contain a wildcard: x"],
    ["conflict", "The request conflicts with the current state."],
    ["forbidden", "You do not have permission to do this."],
  ] as const)("BE %s => form-level alert with its text", async (code, message) => {
    mocks.create.mockResolvedValue(fail(code, message) as never);
    renderAt("/clients/new");
    await screen.findByLabelText("Redirect URIs");
    submit("Create client");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(message);
    expect(alert.innerHTML).not.toContain("<a");
  });

  it("uncertain => 'may have been created', never re-sent, list invalidated", async () => {
    mocks.create.mockResolvedValue(fail("unavailable", "x", true) as never);
    renderAt("/clients/new");
    await screen.findByLabelText("Redirect URIs");
    submit("Create client");
    expect((await screen.findByRole("alert")).textContent).toMatch(/may have been created/);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("submit is disabled while pending: a double click sends once", async () => {
    let resolve!: (v: unknown) => void;
    mocks.create.mockReturnValue(new Promise((r) => (resolve = r)) as never);
    const router = renderAt("/clients/new");
    await screen.findByLabelText("Redirect URIs");
    submit("Create client");
    await waitFor(() => expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await act(async () => resolve(ok({ ...CLIENT, clientId: "new-1" })));
    await waitFor(() => expect(router.state.location.pathname).toBe("/clients/new-1"));
  });

  it("step_up_required => allowlisted draft + re-auth; back: restored, NOT sent, submit sends once", async () => {
    mocks.create.mockResolvedValueOnce(fail("step_up_required") as never);
    renderAt("/clients/new");
    await screen.findByLabelText("Redirect URIs");
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    type("Redirect URIs", "https://app.example/cb2");
    type("Scopes", "openid profile");
    submit("Create client");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/auth/login?stepup=1&returnTo=%2Fclients%2Fnew"));
    const stored = JSON.parse(sessionStorage.getItem(KEY)!);
    expect(stored).toMatchObject({ action: "client.create", path: "/clients/new", sub: "u1" });
    expect(Object.keys(stored.payload).sort()).toEqual(
      [
        "allowedCorsOrigins",
        "allowedResources",
        "clientType",
        "frontchannelLogoutUri",
        "grantTypes",
        "postLogoutRedirectUris",
        "redirectUris",
        "scopes",
        "tokenEndpointAuthMethod",
      ].sort(),
    );
    cleanup();

    mocks.create.mockResolvedValue(ok({ ...CLIENT, clientId: "new-2" }) as never);
    renderAt("/clients/new");
    await waitFor(() => expect(field("Redirect URIs").value).toBe("https://app.example/cb2"));
    expect(screen.getByRole("status").textContent).toMatch(/submit again/);
    expect((screen.getByRole("radio", { name: /Public/ }) as HTMLInputElement).checked).toBe(true);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(mocks.create).toHaveBeenCalledTimes(1); // only the first, refused one
    submit("Create client");
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.create.mock.calls[1]![0]).toMatchObject({
      data: { clientType: "public", tokenEndpointAuthMethod: "none", redirectUris: ["https://app.example/cb2"], scopes: ["openid", "profile"] },
    });
  });
});

describe("edit form", () => {
  it("immutable fields are read-only text, not form controls; PATCH holds only the changed field", async () => {
    mocks.update.mockResolvedValue(ok({ ...CLIENT, redirectUris: ["https://app.example/cb", "https://app.example/cb2"] }) as never);
    renderAt("/clients/app-1");
    await screen.findByLabelText("Redirect URIs");
    expect(screen.getByText("client_secret_basic").tagName).toBe("DD");
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByLabelText(/client type|auth method|tenant/i)).toBeNull();
    submit("Save changes");
    expect((await screen.findByRole("status")).textContent).toBe("No changes to save.");
    expect(mocks.update).not.toHaveBeenCalled();
    type("Redirect URIs", "https://app.example/cb\nhttps://app.example/cb2");
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]![0]).toEqual({
      data: { clientId: "app-1", patch: { redirectUris: ["https://app.example/cb", "https://app.example/cb2"] } },
    });
    expect((await screen.findByRole("status")).textContent).toBe("Saved.");
  });

  it("uncertain update => message, detail re-read (not re-sent)", async () => {
    mocks.update.mockResolvedValue(fail("unavailable", "x", true) as never);
    renderAt("/clients/app-1");
    await screen.findByLabelText("Redirect URIs");
    type("Scopes", "openid email");
    const reads = mocks.get.mock.calls.length;
    submit("Save changes");
    expect((await screen.findByRole("alert")).textContent).toMatch(/result is unknown/);
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(reads));
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("step_up_required => draft (no immutable field) + re-auth; back: restored, NOT sent, diff vs the fresh data", async () => {
    mocks.update.mockResolvedValueOnce(fail("step_up_required") as never);
    renderAt("/clients/app-1");
    await screen.findByLabelText("Redirect URIs");
    type("Redirect URIs", "https://app.example/cb3");
    submit("Save changes");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/auth/login?stepup=1&returnTo=%2Fclients%2Fapp-1"));
    const stored = JSON.parse(sessionStorage.getItem(KEY)!);
    expect(stored).toMatchObject({ action: "client.update", path: "/clients/app-1" });
    expect(stored.payload).toEqual({ redirectUris: "https://app.example/cb3" }); // only what was changed
    cleanup();

    // Meanwhile someone else changed the scopes: the draft is re-applied on top of the fresh data.
    mocks.get.mockResolvedValue(ok({ ...CLIENT, scopes: ["openid", "email"] }) as never);
    mocks.update.mockResolvedValue(ok({ ...CLIENT, redirectUris: ["https://app.example/cb3"] }) as never);
    renderAt("/clients/app-1");
    await waitFor(() => expect(field("Redirect URIs").value).toBe("https://app.example/cb3"));
    expect(screen.getByRole("status").textContent).toMatch(/submit again/);
    expect(field("Scopes").value).toBe("openid email");
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(mocks.update).toHaveBeenCalledTimes(1);
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[1]![0]).toEqual({
      data: { clientId: "app-1", patch: { redirectUris: ["https://app.example/cb3"] } },
    });
  });

  it("refetch while editing (someone else removed a redirect URI): PATCH holds only my field, never their old value", async () => {
    const V1 = { ...CLIENT, redirectUris: ["https://app.example/cb", "https://leaked.example/cb"] };
    const V2 = { ...CLIENT, redirectUris: ["https://app.example/cb"] };
    mocks.get.mockResolvedValue(ok(V1) as never);
    mocks.update.mockResolvedValue(ok({ ...V2, scopes: ["openid", "email"] }) as never);
    renderAt("/clients/app-1");
    await waitFor(() => expect(field("Redirect URIs").value).toBe("https://app.example/cb\nhttps://leaked.example/cb"));
    type("Scopes", "openid email");
    mocks.get.mockResolvedValue(ok(V2) as never);
    await refocusAndRefetch();
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]![0]).toEqual({ data: { clientId: "app-1", patch: { scopes: ["openid", "email"] } } });
  });

  it("refetch while editing, then step-up: the draft holds only my field; restored on newer data, still only that field is sent", async () => {
    const V1 = { ...CLIENT, redirectUris: ["https://app.example/cb", "https://leaked.example/cb"] };
    const V2 = { ...CLIENT, redirectUris: ["https://app.example/cb"] };
    mocks.get.mockResolvedValue(ok(V1) as never);
    mocks.update.mockResolvedValueOnce(fail("step_up_required") as never);
    renderAt("/clients/app-1");
    await waitFor(() => expect(field("Redirect URIs").value).toBe("https://app.example/cb\nhttps://leaked.example/cb"));
    type("Scopes", "openid email");
    mocks.get.mockResolvedValue(ok(V2) as never);
    await refocusAndRefetch();
    submit("Save changes");
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0]).toEqual({ data: { clientId: "app-1", patch: { scopes: ["openid", "email"] } } });
    expect(JSON.parse(sessionStorage.getItem(KEY)!).payload).toEqual({ scopes: "openid email" });
    cleanup();

    // Back from the re-auth: the server moved on again (V3); only the scopes are re-applied and sent.
    const V3 = { ...V2, postLogoutRedirectUris: ["https://app.example/bye"] };
    mocks.get.mockResolvedValue(ok(V3) as never);
    mocks.update.mockResolvedValue(ok({ ...V3, scopes: ["openid", "email"] }) as never);
    renderAt("/clients/app-1");
    await waitFor(() => expect(field("Scopes").value).toBe("openid email"));
    expect(field("Redirect URIs").value).toBe("https://app.example/cb");
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[1]![0]).toEqual({ data: { clientId: "app-1", patch: { scopes: ["openid", "email"] } } });
  });

  // Retry 2: an untouched form must not follow a refetch while the diff base stays put (form-core
  // `update` takes new `defaultValues` while `!isTouched`) => the shown values and the base move together.
  const CB = "https://app.example/cb";
  const LEAKED = "https://leaked.example/cb";
  const LEAKED2 = "https://leaked2.example/cb";

  it("refetch BEFORE editing, edit, refetch again, save: PATCH holds only my field (a revoked URI is never re-added)", async () => {
    mocks.get.mockResolvedValue(ok({ ...CLIENT, redirectUris: [CB, LEAKED, LEAKED2] }) as never);
    mocks.update.mockResolvedValue(ok({ ...CLIENT, scopes: ["openid", "email"] }) as never);
    renderAt("/clients/app-1");
    await waitFor(() => expect(field("Redirect URIs").value).toBe([CB, LEAKED, LEAKED2].join("\n")));
    mocks.get.mockResolvedValue(ok({ ...CLIENT, redirectUris: [CB, LEAKED] }) as never); // V2: B removes leaked2
    await refocusAndRefetch();
    type("Scopes", "openid email");
    mocks.get.mockResolvedValue(ok({ ...CLIENT, redirectUris: [CB] }) as never); // V3: B removes leaked
    await refocusAndRefetch();
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]![0]).toEqual({ data: { clientId: "app-1", patch: { scopes: ["openid", "email"] } } });
  });

  it("restored draft, refetch, edit, refetch, save: only the draft field and my new field are sent", async () => {
    mocks.update.mockResolvedValueOnce(fail("step_up_required") as never);
    renderAt("/clients/app-1");
    await screen.findByLabelText("Redirect URIs");
    type("Scopes", "openid email");
    submit("Save changes");
    await waitFor(() => expect(assign).toHaveBeenCalled());
    cleanup();

    mocks.get.mockResolvedValue(ok({ ...CLIENT, redirectUris: [CB, LEAKED, LEAKED2] }) as never);
    mocks.update.mockResolvedValue(ok(CLIENT) as never);
    renderAt("/clients/app-1");
    await waitFor(() => expect(field("Scopes").value).toBe("openid email"));
    await waitFor(() => expect(field("Redirect URIs").value).toBe([CB, LEAKED, LEAKED2].join("\n")));
    mocks.get.mockResolvedValue(ok({ ...CLIENT, redirectUris: [CB, LEAKED] }) as never);
    await refocusAndRefetch();
    type("Allowed CORS origins", "https://app.example");
    mocks.get.mockResolvedValue(ok({ ...CLIENT, redirectUris: [CB] }) as never);
    await refocusAndRefetch();
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[1]![0]).toEqual({
      data: { clientId: "app-1", patch: { scopes: ["openid", "email"], allowedCorsOrigins: ["https://app.example"] } },
    });
  });

  it("save, refetch returns newer data than saved, edit, refetch, save: PATCH holds only the field just edited", async () => {
    const saved = { ...CLIENT, redirectUris: [CB, LEAKED, LEAKED2], scopes: ["openid", "email"] };
    mocks.get.mockResolvedValue(ok({ ...CLIENT, redirectUris: [CB, LEAKED, LEAKED2] }) as never);
    mocks.update.mockResolvedValueOnce(ok(saved) as never);
    renderAt("/clients/app-1");
    await waitFor(() => expect(field("Redirect URIs").value).toBe([CB, LEAKED, LEAKED2].join("\n")));
    type("Scopes", "openid email");
    // The refetch after the save (invalidate) already sees B's write: leaked2 removed.
    mocks.get.mockResolvedValue(ok({ ...saved, redirectUris: [CB, LEAKED] }) as never);
    const reads = mocks.get.mock.calls.length;
    submit("Save changes");
    expect((await screen.findByRole("status")).textContent).toBe("Saved.");
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(reads));
    await act(() => new Promise((r) => setTimeout(r, 30)));
    type("Allowed CORS origins", "https://app.example");
    mocks.get.mockResolvedValue(ok({ ...saved, redirectUris: [CB] }) as never);
    await refocusAndRefetch();
    mocks.update.mockResolvedValue(ok(saved) as never);
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[0]![0]).toEqual({ data: { clientId: "app-1", patch: { scopes: ["openid", "email"] } } });
    expect(mocks.update.mock.calls[1]![0]).toEqual({
      data: { clientId: "app-1", patch: { allowedCorsOrigins: ["https://app.example"] } },
    });
  });

  it("not found => message", async () => {
    mocks.get.mockResolvedValue(fail("not_found") as never);
    renderAt("/clients/nope");
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not exist/);
  });
});
