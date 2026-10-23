// Run 45 (A6.1b): secrets panel, one-time secret dialog, revoke, disable/enable, through the real
// route tree under StrictMode (server fns mocked). The canary secret must never reach the DOM after
// close, the Query/Mutation caches, Web Storage, the URL, the console or a toast.
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { getClient, listResources, updateClient } from "@/features/admin-api/clients";
import { issueSecret, listSecrets, revokeSecret } from "@/features/admin-api/secrets";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AdminApiErrorCode } from "@/features/admin-api/types";
import { UNCERTAIN_ISSUE } from "@/features/clients/client-secrets";
import { SELF_DISABLE_CONFLICT } from "@/features/clients/client-status";
import type { AdminClient, Credential } from "@/server/admin-api/schemas";

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
vi.mock("@/features/admin-api/secrets", () => ({ listSecrets: vi.fn(), issueSecret: vi.fn(), revokeSecret: vi.fn() }));

const SECRET = "S3CR3T-canary-ui-0123456789abcdef";
const mocks = {
  get: vi.mocked(getClient),
  update: vi.mocked(updateClient),
  list: vi.mocked(listSecrets),
  issue: vi.mocked(issueSecret),
  revoke: vi.mocked(revokeSecret),
};

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
const V1: Credential = { version: 1, createdAt: "2026-10-01T00:00:00.000Z", expiresAt: null, revokedAt: null, status: "active" };
const V1_GRACE: Credential = { ...V1, expiresAt: "2026-10-29T00:00:00.000Z", status: "grace" };
const V2: Credential = { version: 2, createdAt: "2026-10-22T00:00:00.000Z", expiresAt: null, revokedAt: null, status: "active" };
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: AdminApiErrorCode, extra: { uncertain?: true } = {}) => ({ ok: false as const, error: { code, message: `msg ${code}`, ...extra } });

let rows: Credential[];
let assign: ReturnType<typeof vi.fn>;
let logged: string[];
let queryClient: QueryClient;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  rows = [V1];
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x) ?? String(x))).join(" ")));
  }
  for (const level of ["success", "info", "warning", "error", "message"] as const) {
    vi.spyOn(toast, level).mockImplementation(((...a: unknown[]) => {
      logged.push(`toast ${JSON.stringify(a)}`);
      return 1;
    }) as never);
  }
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue({ sub: "u1", email: "admin@example.com", roles: ["tenant_admin"], tenantId: "t1" });
  mocks.get.mockImplementation((async ({ data }: { data: string }) => ok({ ...CLIENT, clientId: data })) as never);
  vi.mocked(listResources).mockResolvedValue(ok([]) as never);
  mocks.list.mockImplementation((async () => ok({ items: rows })) as never);
  mocks.issue.mockImplementation((async () => {
    rows = [V2, V1_GRACE];
    return ok({ clientId: "app-1", version: 2, clientSecret: SECRET });
  }) as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function renderAt(path: string) {
  queryClient = createQueryClient();
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
    // The root route renders <html>/<body> (singletons = the real document.body). Mounted in a
    // <div> inside that body, an event on a Radix portal (also in body) makes React walk
    // body -> root <div> -> body forever. The app hydrates `document`: do the same here.
    { container: document as never },
  );
  return router;
}

/** Every place the plaintext must not be (the DOM only while the dialog is open). */
function stores(withDom = true): string {
  const parts = [
    JSON.stringify(queryClient.getQueryCache().getAll().map((q) => ({ key: q.queryKey, state: q.state }))),
    JSON.stringify(queryClient.getMutationCache().getAll().map((m) => m.state)),
    JSON.stringify({ ...localStorage }),
    JSON.stringify({ ...sessionStorage }),
    location.href,
    window.location.href,
    logged.join("\n"),
  ];
  if (withDom) parts.push(document.body.innerHTML);
  return parts.join("\n");
}

// Plain DOM events (fireEvent): enough for these dialogs and independent of pointer emulation.
const click = (el: Element) => fireEvent.click(el);
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
const rotateButton = () => screen.findByRole("button", { name: "Rotate secret" });

async function openAndIssue() {
  click(await rotateButton());
  const dialog = await screen.findByRole("dialog");
  click(within(dialog).getByRole("button", { name: "Rotate secret" }));
  const code = await within(dialog).findByTestId("issued-secret");
  return { dialog, code };
}

describe("secrets panel", () => {
  it("lists versions (metadata only), Revoke only for active/grace, Issue vs Rotate by usable versions", async () => {
    rows = [
      { ...V2, status: "active" },
      { ...V1, status: "revoked", revokedAt: "2026-10-20T00:00:00.000Z" },
      { version: 3, createdAt: "c", expiresAt: "2026-10-02T00:00:00.000Z", revokedAt: null, status: "expired" },
    ];
    renderAt("/clients/app-1");
    const table = await screen.findByRole("table", { name: "Secret versions" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Revoke version 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke version 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke version 3" })).toBeNull();
    expect(screen.getByRole("button", { name: "Rotate secret" })).toBeTruthy();
    expect(table.textContent).not.toMatch(/hash/i);
  });

  it("no usable version => 'Issue secret'", async () => {
    rows = [];
    renderAt("/clients/app-1");
    expect(await screen.findByRole("button", { name: "Issue secret" })).toBeTruthy();
    expect(screen.getByText(/No secret yet/)).toBeTruthy();
  });

  it("public client: no secrets panel and no secrets request", async () => {
    mocks.get.mockResolvedValue(ok({ ...CLIENT, clientType: "public", tokenEndpointAuthMethod: "none" }) as never);
    renderAt("/clients/app-1");
    await screen.findByRole("heading", { name: "Status" });
    expect(screen.queryByRole("heading", { name: "Secrets" })).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("403 on the list (admin-capable client, not super_admin) => the forbidden message", async () => {
    mocks.list.mockResolvedValue(fail("forbidden") as never);
    renderAt("/clients/app-1");
    expect((await screen.findByText("msg forbidden")).closest("[role=alert]")).toBeTruthy();
  });
});

describe("one-time secret dialog", () => {
  it("shows the secret as text once; while open it is in no cache/storage/URL/log; after Close it is gone everywhere and focus returns", async () => {
    renderAt("/clients/app-1");
    const trigger = await rotateButton();
    click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true); // focus moved into the dialog
    click(within(dialog).getByRole("button", { name: "Rotate secret" }));
    const code = await within(dialog).findByTestId("issued-secret");
    expect(code.tagName).toBe("CODE");
    expect(code.textContent).toBe(SECRET);
    expect([...document.querySelectorAll("input,textarea")].some((e) => (e as HTMLInputElement).value.includes(SECRET))).toBe(false);
    expect([...document.querySelectorAll("[aria-live],[role=status],[role=alert]")].some((e) => e.textContent!.includes(SECRET))).toBe(false);
    expect(within(dialog).getByText(/shown only once/).getAttribute("role")).toBe("status");
    expect(stores(false)).not.toContain(SECRET);
    expect(mocks.issue).toHaveBeenCalledWith({ data: "app-1" });
    // The list was re-read: the previous version's grace end comes from the BE.
    expect(await within(dialog).findByText("Version 1 keeps working until 2026-10-29T00:00:00.000Z.")).toBeTruthy();

    click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stores()).not.toContain(SECRET);
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByTestId("issued-secret")).toBeNull();
  });

  it("Escape closes it and drops the secret; an outside click does not close it", async () => {
    renderAt("/clients/app-1");
    const { dialog } = await openAndIssue();
    // A click on the overlay (outside the content) must not close it: the secret would be lost.
    const overlay = dialog.previousElementSibling!;
    expect(overlay.contains(dialog)).toBe(false);
    fireEvent.pointerDown(overlay);
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.getByRole("dialog")).toBe(dialog);
    escape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stores()).not.toContain(SECRET);
  });

  it("pagehide drops the secret and closes the dialog", async () => {
    renderAt("/clients/app-1");
    await openAndIssue();
    act(() => void window.dispatchEvent(new Event("pagehide")));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stores()).not.toContain(SECRET);
  });

  it("DEBT-308: navigating to another client while the dialog shows a secret => gone from the DOM", async () => {
    // app-2 first, so its detail is cached and the page does not go through "pending" (no remount).
    const router = renderAt("/clients/app-2");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("app-2"));
    await act(() => router.navigate({ to: "/clients/$clientId", params: { clientId: "app-1" } }));
    await openAndIssue();
    await act(() => router.navigate({ to: "/clients/$clientId", params: { clientId: "app-2" } }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("app-2"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stores()).not.toContain(SECRET);
  });

  it("double click on Rotate => issued exactly once", async () => {
    let release: () => void = () => undefined;
    mocks.issue.mockImplementation((async () => {
      await new Promise<void>((r) => (release = r));
      return ok({ clientId: "app-1", version: 2, clientSecret: SECRET });
    }) as never);
    renderAt("/clients/app-1");
    click(await rotateButton());
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Rotate secret" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Working…" }).hasAttribute("disabled")).toBe(true));
    escape(); // pending: the dialog stays (its secret is shown once)
    expect(screen.getByRole("dialog")).toBe(dialog);
    await act(async () => release());
    await within(dialog).findByTestId("issued-secret");
    expect(mocks.issue).toHaveBeenCalledTimes(1);
  });

  it("step_up_required: alert + 'Confirm identity' (no stored intent); back, nothing is re-sent", async () => {
    mocks.issue.mockResolvedValue(fail("step_up_required") as never);
    renderAt("/clients/app-1");
    click(await rotateButton());
    const dialog = await screen.findByRole("dialog");
    click(within(dialog).getByRole("button", { name: "Rotate secret" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Unsaved changes in Settings will be lost.");
    expect(assign).not.toHaveBeenCalled(); // no automatic redirect
    click(within(alert).getByRole("button", { name: "Confirm identity" }));
    expect(assign).toHaveBeenCalledWith(`/auth/login?stepup=1&returnTo=${encodeURIComponent("/clients/app-1")}`);
    expect(sessionStorage.getItem("fea:stepup")).toBeNull();
    // Coming back: a fresh page with nothing pending.
    cleanup();
    renderAt("/clients/app-1");
    await rotateButton();
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uncertain: its own message, the list is re-read, nothing re-sent", async () => {
    mocks.issue.mockResolvedValue(fail("unavailable", { uncertain: true }) as never);
    renderAt("/clients/app-1");
    click(await rotateButton());
    const dialog = await screen.findByRole("dialog");
    const before = mocks.list.mock.calls.length;
    click(within(dialog).getByRole("button", { name: "Rotate secret" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(UNCERTAIN_ISSUE);
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(before));
    expect(mocks.issue).toHaveBeenCalledTimes(1);
  });

  it("unauthenticated: sign in again (no message with the secret, nothing stored)", async () => {
    mocks.issue.mockResolvedValue(fail("unauthenticated") as never);
    renderAt("/clients/app-1");
    click(await rotateButton());
    click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Rotate secret" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringMatching(/^\/auth\/login\?returnTo=/)));
  });

  it.each([
    ["resolves", () => ({ writeText: vi.fn(async () => undefined) }), "Copied. Clear your clipboard once the secret is stored."],
    ["rejects", () => ({ writeText: vi.fn(async () => Promise.reject(new Error(SECRET))) }), "Copy failed — select the text and copy it manually."],
    ["is missing", () => undefined, "Copy failed — select the text and copy it manually."],
  ])("copy: Clipboard API %s => status message without the secret", async (_, clipboard, message) => {
    const value = clipboard();
    Object.defineProperty(navigator, "clipboard", { value, configurable: true });
    renderAt("/clients/app-1");
    const { dialog } = await openAndIssue();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy" }));
    const status = await within(dialog).findByText(message);
    expect(status.getAttribute("role")).toBe("status");
    if (value) expect(value.writeText).toHaveBeenCalledWith(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
  });
});

describe("revoke", () => {
  it("confirmation names the version, no grace; the last usable version gets an alert; confirm => DELETE that version", async () => {
    mocks.revoke.mockImplementation((async () => {
      rows = [{ ...V1, status: "revoked", revokedAt: "r" }];
      return ok(undefined);
    }) as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Revoke version 1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Version 1 stops working immediately, with no grace period.");
    expect(within(dialog).getByRole("alert").textContent).toContain("last usable secret");
    click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.revoke).toHaveBeenCalledWith({ data: { clientId: "app-1", version: 1 } });
    expect(await screen.findByText("Version 1 revoked.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Revoke version/ })).toBeNull());
  });

  it("not the last usable version => no last-secret alert; Cancel sends nothing", async () => {
    rows = [V2, V1_GRACE];
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Revoke version 1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", fail("not_found"), "This version was already revoked or does not exist. The version list was reloaded."],
    ["uncertain", fail("unavailable", { uncertain: true }), "The result is unknown. The version list was reloaded: check it before trying again."],
  ])("%s => message in the dialog and the list is re-read", async (_, result, message) => {
    mocks.revoke.mockResolvedValue(result as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Revoke version 1" }));
    const dialog = await screen.findByRole("alertdialog");
    const before = mocks.list.mock.calls.length;
    click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(await within(dialog).findByText(message)).toBeTruthy();
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(before));
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
  });

  it("double click on Revoke => one request", async () => {
    let release: () => void = () => undefined;
    mocks.revoke.mockImplementation((async () => {
      await new Promise<void>((r) => (release = r));
      return ok(undefined);
    }) as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Revoke version 1" }));
    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalled());
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
  });

  it("step_up_required => Confirm identity, no intent stored", async () => {
    mocks.revoke.mockResolvedValue(fail("step_up_required") as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Revoke version 1" }));
    const dialog = await screen.findByRole("alertdialog");
    click(within(dialog).getByRole("button", { name: "Revoke" }));
    click(await within(dialog).findByRole("button", { name: "Confirm identity" }));
    expect(assign).toHaveBeenCalledWith(`/auth/login?stepup=1&returnTo=${encodeURIComponent("/clients/app-1")}`);
    expect(sessionStorage.getItem("fea:stepup")).toBeNull();
  });
});

describe("disable / enable", () => {
  it("disable: confirmation about refresh tokens, PATCH { disabled: true } alone, then the status follows", async () => {
    mocks.update.mockResolvedValue(ok({ ...CLIENT, disabled: true }) as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Disable client" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("revokes every refresh token of this client");
    mocks.get.mockResolvedValue(ok({ ...CLIENT, disabled: true }) as never);
    click(within(dialog).getByRole("button", { name: "Disable client" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0]![0]).toEqual({ data: { clientId: "app-1", patch: { disabled: true } } });
    expect(await screen.findByText("Client disabled.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Enable client" })).toBeTruthy();
  });

  it("409 on disable => the self-lockout message", async () => {
    mocks.update.mockResolvedValue(fail("conflict") as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Disable client" }));
    const dialog = await screen.findByRole("alertdialog");
    click(within(dialog).getByRole("button", { name: "Disable client" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(SELF_DISABLE_CONFLICT);
  });

  it("step_up_required on disable => Confirm identity, nothing stored, nothing re-sent", async () => {
    mocks.update.mockResolvedValue(fail("step_up_required") as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Disable client" }));
    const dialog = await screen.findByRole("alertdialog");
    click(within(dialog).getByRole("button", { name: "Disable client" }));
    expect(await within(dialog).findByRole("button", { name: "Confirm identity" })).toBeTruthy();
    expect(sessionStorage.getItem("fea:stepup")).toBeNull();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("enable: PATCH { disabled: false } after a short confirmation", async () => {
    mocks.get.mockResolvedValue(ok({ ...CLIENT, disabled: true }) as never);
    mocks.update.mockResolvedValue(ok(CLIENT) as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Enable client" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("do not come back");
    click(within(dialog).getByRole("button", { name: "Enable client" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]![0]).toEqual({ data: { clientId: "app-1", patch: { disabled: false } } });
  });
});
