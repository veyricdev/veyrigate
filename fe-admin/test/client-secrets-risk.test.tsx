// Run 45 tester risk matrix (A6.1b): canary absence after every close path, issue failures
// (network/throw/uncertain), unmount while pending, last usable version, double clicks, disable
// `uncertain` + refetch (DEBT-313), list refetch error while the secret is shown (DEBT-314), keyboard a11y.
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { getClient, listClients, listResources, updateClient } from "@/features/admin-api/clients";
import { issueSecret, listSecrets, revokeSecret } from "@/features/admin-api/secrets";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AdminApiErrorCode } from "@/features/admin-api/types";
import { UNCERTAIN_ISSUE } from "@/features/clients/client-secrets";
import { SELF_DISABLE_CONFLICT, UNCERTAIN_STATUS } from "@/features/clients/client-status";
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
const tick = (ms = 30) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("canary: after every way out, nowhere, and never shown again", () => {
  const ways: [string, (router: ReturnType<typeof renderAt>, dialog: HTMLElement) => Promise<void> | void][] = [
    ["Close button", (_r, d) => void click(within(d).getByRole("button", { name: "Close" }))],
    ["Escape", () => void escape()],
    ["pagehide", () => void act(() => void window.dispatchEvent(new Event("pagehide")))],
    ["navigation to the clients list", (r) => act(() => r.navigate({ to: "/clients" }))],
  ];
  it.each(ways)("%s => gone from DOM/caches/storage/URL/log, a refetch does not bring it back, reopening shows no secret", async (_, leave) => {
    vi.mocked(listClients).mockResolvedValue(ok({ items: [CLIENT], nextCursor: null }) as never);
    const router = renderAt("/clients/app-1");
    const { dialog } = await openAndIssue();
    await leave(router, dialog);
    await waitFor(() => expect(screen.queryByTestId("issued-secret")).toBeNull());
    expect(stores()).not.toContain(SECRET);
    await act(() => queryClient.invalidateQueries());
    await tick();
    expect(stores()).not.toContain(SECRET);
    if (router.state.location.pathname !== "/clients/app-1") {
      await act(() => router.navigate({ to: "/clients/$clientId", params: { clientId: "app-1" } }));
    }
    click(await rotateButton());
    const again = await screen.findByRole("dialog");
    expect(within(again).queryByTestId("issued-secret")).toBeNull();
    expect(stores()).not.toContain(SECRET);
    expect(mocks.issue).toHaveBeenCalledTimes(1);
  });

  it("unmount of the whole app while the secret is shown => nothing left behind", async () => {
    renderAt("/clients/app-1");
    await openAndIssue();
    cleanup();
    expect(stores()).not.toContain(SECRET);
  });

  it("navigating away while the issue is pending, then the answer arrives => the secret is shown nowhere", async () => {
    let release: () => void = () => undefined;
    mocks.issue.mockImplementation((async () => {
      await new Promise<void>((r) => (release = r));
      return ok({ clientId: "app-1", version: 2, clientSecret: SECRET });
    }) as never);
    const router = renderAt("/clients/app-2");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("app-2"));
    await act(() => router.navigate({ to: "/clients/$clientId", params: { clientId: "app-1" } }));
    click(await rotateButton());
    click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Rotate secret" }));
    await waitFor(() => expect(mocks.issue).toHaveBeenCalledTimes(1));
    await act(() => router.navigate({ to: "/clients/$clientId", params: { clientId: "app-2" } }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("app-2"));
    await act(async () => release());
    await tick();
    expect(screen.queryByTestId("issued-secret")).toBeNull();
    expect(stores()).not.toContain(SECRET);
  });

  it("pagehide while the issue is pending => closed, the late answer is dropped, the list is still re-read", async () => {
    let release: () => void = () => undefined;
    mocks.issue.mockImplementation((async () => {
      await new Promise<void>((r) => (release = r));
      rows = [V2, V1_GRACE];
      return ok({ clientId: "app-1", version: 2, clientSecret: SECRET });
    }) as never);
    renderAt("/clients/app-1");
    click(await rotateButton());
    click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Rotate secret" }));
    await waitFor(() => expect(mocks.issue).toHaveBeenCalledTimes(1));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => release());
    expect(await screen.findByRole("button", { name: "Revoke version 2" })).toBeTruthy();
    expect(stores()).not.toContain(SECRET);
  });
});

describe("issue failures", () => {
  it("throw that is not an AdminRequestError (network / BFF 500), message holding the canary => not shown, list re-read, nothing re-sent", async () => {
    mocks.issue.mockRejectedValue(new TypeError(`Failed to fetch ${SECRET}`));
    renderAt("/clients/app-1");
    click(await rotateButton());
    const dialog = await screen.findByRole("dialog");
    const before = mocks.list.mock.calls.length;
    click(within(dialog).getByRole("button", { name: "Rotate secret" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(UNCERTAIN_ISSUE); // DEBT-315: a version may have been created
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(before));
    await tick();
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    expect(stores()).not.toContain(SECRET);
  });

  it("DEBT-315: a thrown issue error is an unknown outcome => UNCERTAIN_ISSUE", async () => {
    mocks.issue.mockRejectedValue(new TypeError("Failed to fetch"));
    renderAt("/clients/app-1");
    click(await rotateButton());
    const dialog = await screen.findByRole("dialog");
    click(within(dialog).getByRole("button", { name: "Rotate secret" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(UNCERTAIN_ISSUE);
  });

  it.each([
    ["unavailable (BFF 5xx, uncertain)", fail("unavailable", { uncertain: true }), UNCERTAIN_ISSUE],
    ["forbidden (admin-capable, not super_admin)", fail("forbidden"), "msg forbidden"],
    ["not_found (client gone)", fail("not_found"), "msg not_found"],
  ])("%s => its message, Cancel then closes, no secret, issued once", async (_, result, message) => {
    mocks.issue.mockResolvedValue(result as never);
    renderAt("/clients/app-1");
    click(await rotateButton());
    const dialog = await screen.findByRole("dialog");
    click(within(dialog).getByRole("button", { name: "Rotate secret" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(message);
    click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    expect(stores()).not.toContain(SECRET);
  });

  it("Cancel is disabled and Escape ignored while pending (no second issue)", async () => {
    let release: () => void = () => undefined;
    mocks.issue.mockImplementation((async () => {
      await new Promise<void>((r) => (release = r));
      return ok({ clientId: "app-1", version: 2, clientSecret: SECRET });
    }) as never);
    renderAt("/clients/app-1");
    click(await rotateButton());
    const dialog = await screen.findByRole("dialog");
    click(within(dialog).getByRole("button", { name: "Rotate secret" }));
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel.hasAttribute("disabled")).toBe(true));
    click(cancel);
    escape();
    expect(screen.getByRole("dialog")).toBe(dialog);
    await act(async () => release());
    expect((await within(dialog).findByTestId("issued-secret")).textContent).toBe(SECRET);
    expect(mocks.issue).toHaveBeenCalledTimes(1);
  });
});

describe("DEBT-314: list refetch fails while the one-time secret is shown", () => {
  async function issueThenFailList() {
    mocks.issue.mockImplementation((async () => {
      mocks.list.mockResolvedValue(fail("unavailable") as never); // the re-read after issue fails
      return ok({ clientId: "app-1", version: 2, clientSecret: SECRET });
    }) as never);
    renderAt("/clients/app-1");
    click(await rotateButton());
    click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Rotate secret" }));
  }

  it("the secret stays visible until the admin closes the dialog, then it is gone (list error shown)", async () => {
    await issueThenFailList();
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThanOrEqual(2));
    await tick(50);
    expect(screen.getByText("msg unavailable").closest("[role=alert]")).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("issued-secret").textContent).toBe(SECRET);
    click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stores()).not.toContain(SECRET);
  });
});

describe("DEBT-316: client detail refetch fails while the one-time secret is shown", () => {
  it("the error is shown above the last data, the secret stays until the dialog is closed, then it is gone", async () => {
    renderAt("/clients/app-1");
    const { dialog } = await openAndIssue();
    mocks.get.mockResolvedValue(fail("unavailable") as never);
    await act(() => queryClient.invalidateQueries({ queryKey: ["admin", "clients", "detail"] }));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThanOrEqual(2));
    await tick(50);
    expect(screen.getByText("msg unavailable").closest("[role=alert]")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByTestId("issued-secret").textContent).toBe(SECRET);
    click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stores()).not.toContain(SECRET);
  });
});

describe("revoke: last usable version", () => {
  it("only a grace version left (active one revoked) => it is the last usable: alert; after revoke the button reads 'Issue secret'", async () => {
    rows = [{ ...V2, status: "revoked", revokedAt: "r" }, V1_GRACE];
    mocks.revoke.mockImplementation((async () => {
      rows = [{ ...V2, status: "revoked", revokedAt: "r" }, { ...V1_GRACE, status: "revoked", revokedAt: "r" }];
      return ok(undefined);
    }) as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Revoke version 1" }));
    expect(screen.queryByRole("button", { name: "Revoke version 2" })).toBeNull();
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("alert").textContent).toContain("last usable secret");
    click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByRole("button", { name: "Issue secret" })).toBeTruthy();
    expect(mocks.revoke).toHaveBeenCalledWith({ data: { clientId: "app-1", version: 1 } });
  });

  it("active + grace => revoking the active one is not the last: no alert", async () => {
    rows = [V2, V1_GRACE];
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Revoke version 2" }));
    expect(within(await screen.findByRole("alertdialog")).queryByRole("alert")).toBeNull();
  });
});

describe("disable / enable risks", () => {
  it("double click on Disable confirm => one PATCH", async () => {
    let release: () => void = () => undefined;
    mocks.update.mockImplementation((async () => {
      await new Promise<void>((r) => (release = r));
      return ok({ ...CLIENT, disabled: true });
    }) as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Disable client" }));
    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disable client" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("409 on ENABLE is not the self-lockout message", async () => {
    mocks.get.mockResolvedValue(ok({ ...CLIENT, disabled: true }) as never);
    mocks.update.mockResolvedValue(fail("conflict") as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Enable client" }));
    const dialog = await screen.findByRole("alertdialog");
    click(within(dialog).getByRole("button", { name: "Enable client" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("msg conflict");
    expect(alert.textContent).not.toBe(SELF_DISABLE_CONFLICT);
  });

  async function disableUncertain() {
    mocks.update.mockImplementation((async () => {
      // The PATCH did go through; only its answer was lost.
      mocks.get.mockResolvedValue(ok({ ...CLIENT, disabled: true, disabledAt: "2026-10-23T00:00:00.000Z" }) as never);
      return fail("unavailable", { uncertain: true });
    }) as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Disable client" }));
    const dialog = await screen.findByRole("alertdialog");
    click(within(dialog).getByRole("button", { name: "Disable client" }));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThanOrEqual(2)); // detail re-read
    await tick(50);
    return dialog;
  }

  it("DEBT-313: uncertain Disable => the dialog is gone (no Enable confirm in its place), the message stays outside it, nothing re-sent", async () => {
    await disableUncertain();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText(UNCERTAIN_STATUS).getAttribute("role")).toBe("status");
    expect(await screen.findByRole("button", { name: "Enable client" })).toBeTruthy(); // the trigger, not a confirm
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("DEBT-313: uncertain Disable that did NOT go through => closed with the message, Disable available again", async () => {
    mocks.update.mockResolvedValue(fail("unavailable", { uncertain: true }) as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Disable client" }));
    click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disable client" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText(UNCERTAIN_STATUS)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable client" })).toBeTruthy();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("DEBT-313: an open Disable confirmation is replaced (not relabelled) when the status changes underneath", async () => {
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Disable client" }));
    await screen.findByRole("alertdialog");
    mocks.get.mockResolvedValue(ok({ ...CLIENT, disabled: true }) as never);
    await act(() => queryClient.invalidateQueries({ queryKey: ["admin", "clients", "detail"] }));
    expect(await screen.findByRole("button", { name: "Enable client" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("keyboard a11y of the dialogs", () => {
  it("secret dialog: named by its title, described, Tab loops inside, Escape returns focus to the trigger", async () => {
    renderAt("/clients/app-1");
    const trigger = await rotateButton();
    click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Rotate secret");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toContain("shown only once");
    const buttons = within(dialog).getAllByRole("button");
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    act(() => last.focus());
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    escape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("confirmation (Disable): initial focus on Cancel (safe default), Escape closes without sending, focus back on the trigger", async () => {
    renderAt("/clients/app-1");
    const trigger = await screen.findByRole("button", { name: "Disable client" });
    click(trigger);
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Disable this client?");
    escape();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

// ---- Tester round 2 (after frontend-dev retry 1): DEBT-313/314/315/316 closed, DEBT-318 characterised.
const UNCERTAIN_REVOKE = "The result is unknown. The version list was reloaded: check it before trying again.";

describe("round 2: no one-click way back after an unknown Disable / Enable", () => {
  it("uncertain Disable that went through: Enable needs the trigger AND a deliberate confirm; the trigger alone sends nothing", async () => {
    mocks.update.mockImplementation((async () => {
      mocks.get.mockResolvedValue(ok({ ...CLIENT, disabled: true, disabledAt: "2026-10-23T00:00:00.000Z" }) as never);
      return fail("unavailable", { uncertain: true });
    }) as never);
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Disable client" }));
    click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disable client" }));
    const trigger = await screen.findByRole("button", { name: "Enable client" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(UNCERTAIN_STATUS);
    click(trigger);
    const dialog = await screen.findByRole("alertdialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Enable this client?");
    expect(within(dialog).queryByRole("alert")).toBeNull(); // fresh instance: no stale "try again"
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel")); // safe default
    await tick();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Disable", false, "Disable client"],
    ["Enable", true, "Enable client"],
  ] as const)("%s throws (network / BFF 500, canary in message) => dialog closed, UNCERTAIN_STATUS notice, nothing re-sent, no canary", async (_, disabled, label) => {
    mocks.get.mockResolvedValue(ok({ ...CLIENT, disabled }) as never);
    mocks.update.mockRejectedValue(new TypeError(`Failed to fetch ${SECRET}`));
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: label }));
    click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: label }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toBe(UNCERTAIN_STATUS);
    await tick();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(stores()).not.toContain(SECRET);
  });

  it("DEBT-318 characterisation: a thrown Disable does NOT re-read the detail although the notice says 'reloaded'", async () => {
    mocks.update.mockRejectedValue(new TypeError("Failed to fetch"));
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Disable client" }));
    const before = mocks.get.mock.calls.length;
    click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disable client" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await tick(80);
    expect(mocks.get.mock.calls.length).toBe(before); // current: no refetch (DEBT-318)
    expect(screen.getByText(UNCERTAIN_STATUS)).toBeTruthy();
    // Stale trigger is the SAME action (disable again => idempotent), never the opposite one.
    expect(screen.getByRole("button", { name: "Disable client" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enable client" })).toBeNull();
  });
});

describe("round 2: revoke unknown outcome", () => {
  it("revoke throws (canary in message) => uncertain text in the dialog, revoked once, no canary; DEBT-318: list not re-read", async () => {
    mocks.revoke.mockRejectedValue(new TypeError(`Failed to fetch ${SECRET}`));
    rows = [V2, V1_GRACE]; // not the last usable: no warning alert in the way
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Revoke version 2" }));
    const dialog = await screen.findByRole("alertdialog");
    const before = mocks.list.mock.calls.length;
    click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(UNCERTAIN_REVOKE);
    await tick(80);
    expect(mocks.list.mock.calls.length).toBe(before); // DEBT-318 characterisation
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    expect(stores()).not.toContain(SECRET);
  });

  it("revoke uncertain (AdminRequestError) => list re-read, revoked once; a repeat is answered by 404 'already revoked'", async () => {
    mocks.revoke.mockResolvedValueOnce(fail("unavailable", { uncertain: true }) as never).mockResolvedValueOnce(fail("not_found") as never);
    rows = [V2, V1_GRACE]; // not the last usable: no warning alert in the way
    renderAt("/clients/app-1");
    click(await screen.findByRole("button", { name: "Revoke version 2" }));
    const dialog = await screen.findByRole("alertdialog");
    const before = mocks.list.mock.calls.length;
    click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(UNCERTAIN_REVOKE);
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(before));
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("already revoked");
    expect(mocks.revoke).toHaveBeenCalledTimes(2);
  });
});

describe("round 2: refetch that THROWS while the one-time secret is shown", () => {
  it.each([
    ["detail", () => mocks.get.mockRejectedValue(new TypeError("Failed to fetch")), ["admin", "clients", "detail"]],
    ["secret list", () => mocks.list.mockRejectedValue(new TypeError("Failed to fetch")), ["admin", "clients"]],
  ] as const)("%s refetch throws => same dialog, secret still shown; after Close nowhere (DOM/cache/storage/URL/log)", async (_, breakIt, key) => {
    renderAt("/clients/app-1");
    const { dialog } = await openAndIssue();
    breakIt();
    await act(() => queryClient.invalidateQueries({ queryKey: [...key] }).catch(() => undefined));
    await tick(80);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByTestId("issued-secret").textContent).toBe(SECRET);
    click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stores()).not.toContain(SECRET);
    // Re-open: no remnant.
    click(await rotateButton());
    expect(within(await screen.findByRole("dialog")).queryByTestId("issued-secret")).toBeNull();
    expect(stores(false)).not.toContain(SECRET);
  });
});
