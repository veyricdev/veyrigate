// Tester run 44 (A6.1): UI risk matrix for the clients pages, through the real route tree under
// StrictMode (server fns mocked, same harness as clients-ui.test.tsx):
// - Exposure: stored URIs / BE error text / client id with markup render as text only;
// - Input: tampered step-up drafts never smuggle immutable fields, `disabled` or unknown keys;
// - Authorization (display only): public + admin resource is sent, the BE 400 is a form-level alert;
// - State: lost-update variants (revert, client switch with a cached detail);
// - a11y: keyboard-only create (Tab order, Space on radios/checkboxes, Enter submits).
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { createClient, getClient, listClients, listResources, updateClient } from "@/features/admin-api/clients";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AdminApiErrorCode } from "@/features/admin-api/types";
import type { AdminClient } from "@/server/admin-api/schemas";

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
const XSS = `<script>window.__pwned=1</script><img src=x onerror="window.__pwned=1">`;

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
const fail = (code: AdminApiErrorCode, message = "m") => ({ ok: false as const, error: { code, message } });

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  delete (window as { __pwned?: number }).__pwned;
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue({ sub: "u1", email: "admin@example.com", roles: ["tenant_admin"], tenantId: "t1" });
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
const noInjectedMarkup = () => {
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector("img")).toBeNull();
  expect([...document.querySelectorAll("a")].some((a) => /^\s*(javascript|data):/i.test(a.getAttribute("href") ?? ""))).toBe(false);
  expect((window as { __pwned?: number }).__pwned).toBeUndefined();
};
const storeDraft = (action: string, path: string, payload: unknown) =>
  sessionStorage.setItem(KEY, JSON.stringify({ v: 1, action, path, sub: "u1", payload, exp: Date.now() + 60_000 }));

describe("exposure: markup in stored data / BE errors is text only", () => {
  it("list: a stored URI with markup or a javascript: scheme is plain text", async () => {
    mocks.list.mockResolvedValue(
      ok({ items: [{ ...CLIENT, redirectUris: [`https://a.example/${XSS}`, "javascript:alert(1)"] }], nextCursor: null }) as never,
    );
    renderAt("/clients");
    const table = await screen.findByRole("table", { name: "Clients" });
    expect(table.textContent).toContain(`https://a.example/${XSS}`);
    noInjectedMarkup();
  });

  it("detail: stored URIs with markup are shown as form values (text), never as links or markup", async () => {
    mocks.get.mockResolvedValue(
      ok({
        ...CLIENT,
        redirectUris: [`https://a.example/${XSS}`],
        postLogoutRedirectUris: ["javascript:alert(1)"],
        frontchannelLogoutUri: "data:text/html,<script>alert(1)</script>",
        allowedCorsOrigins: [`https://${XSS}`],
      }) as never,
    );
    renderAt("/clients/app-1");
    await waitFor(() => expect(field("Redirect URIs").value).toBe(`https://a.example/${XSS}`));
    expect(field("Post-logout redirect URIs").value).toBe("javascript:alert(1)");
    expect(field("Front-channel logout URI").value).toBe("data:text/html,<script>alert(1)</script>");
    noInjectedMarkup();
  });

  it("a client id with markup in the URL is a heading text and a fixed not-found message", async () => {
    mocks.get.mockResolvedValue(fail("not_found") as never);
    renderAt(`/clients/${encodeURIComponent(XSS)}`);
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not exist/);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(XSS);
    noInjectedMarkup();
  });

  it.each(["create", "update"] as const)("BE 400 description with markup (%s) => alert text only", async (op) => {
    const message = `redirect_uri must use https: ${XSS}`;
    if (op === "create") {
      mocks.create.mockResolvedValue(fail("invalid_request", message) as never);
      renderAt("/clients/new");
      await screen.findByLabelText("Redirect URIs");
      submit("Create client");
    } else {
      mocks.update.mockResolvedValue(fail("invalid_request", message) as never);
      renderAt("/clients/app-1");
      await screen.findByLabelText("Redirect URIs");
      type("Scopes", "openid email");
      submit("Save changes");
    }
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(message);
    expect(alert.children.length).toBe(0);
    noInjectedMarkup();
  });
});

describe("input: a tampered step-up draft never reaches the request beyond the allowlist", () => {
  it("create: clientId/tenantId/disabled/secret in the draft are dropped; an invalid type/method pair is reset", async () => {
    storeDraft("client.create", "/clients/new", {
      ...{ grantTypes: ["authorization_code"], redirectUris: "https://app.example/cb", postLogoutRedirectUris: "" },
      ...{ frontchannelLogoutUri: "", allowedCorsOrigins: "", allowedResources: [], scopes: "openid" },
      clientType: "public",
      tokenEndpointAuthMethod: "client_secret_basic", // invalid for public
      clientId: "attacker-chosen",
      tenantId: "other-tenant",
      disabled: true,
      clientSecret: "s3cr3t",
    });
    mocks.create.mockResolvedValue(ok({ ...CLIENT, clientId: "new-1" }) as never);
    renderAt("/clients/new");
    await waitFor(() => expect(field("Redirect URIs").value).toBe("https://app.example/cb"));
    expect(within(document.querySelector("form[novalidate]")!).getByRole("status").textContent).toMatch(/submit again/);
    expect(mocks.create).not.toHaveBeenCalled();
    submit("Create client");
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]![0]).toStrictEqual({
      data: {
        clientType: "public",
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code"],
        redirectUris: ["https://app.example/cb"],
        postLogoutRedirectUris: [],
        allowedCorsOrigins: [],
        allowedResources: [],
        scopes: ["openid"],
      },
    });
  });

  it("update: immutable fields / disabled / unknown keys in the draft are dropped; only the changed field is sent", async () => {
    storeDraft("client.update", "/clients/app-1", {
      scopes: "openid email",
      clientId: "app-2",
      clientType: "public",
      tokenEndpointAuthMethod: "none",
      tenantId: "other-tenant",
      disabled: true,
      clientSecret: "s3cr3t",
    });
    mocks.update.mockResolvedValue(ok({ ...CLIENT, scopes: ["openid", "email"] }) as never);
    renderAt("/clients/app-1");
    await waitFor(() => expect(field("Scopes").value).toBe("openid email"));
    expect(screen.getByText("client_secret_basic").tagName).toBe("DD"); // facts from the server, not the draft
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]![0]).toStrictEqual({ data: { clientId: "app-1", patch: { scopes: ["openid", "email"] } } });
  });

  it("a draft for another client / viewer / action is ignored (and consumed)", async () => {
    for (const [action, path, sub] of [
      ["client.update", "/clients/app-2", "u1"],
      ["client.update", "/clients/app-1", "u2"],
      ["client.create", "/clients/app-1", "u1"],
    ]) {
      sessionStorage.setItem(KEY, JSON.stringify({ v: 1, action, path, sub, payload: { scopes: "evil" }, exp: Date.now() + 60_000 }));
      renderAt("/clients/app-1");
      await waitFor(() => expect(field("Scopes").value).toBe("openid"));
      await act(() => new Promise((r) => setTimeout(r, 20)));
      expect(field("Scopes").value).toBe("openid");
      expect(screen.queryByText(/submit again/)).toBeNull();
      expect(sessionStorage.getItem(KEY)).toBeNull();
      cleanup();
    }
  });
});

describe("authorization (display only): the BE decides", () => {
  it("public client + admin resource: sent as chosen, BE 400 shown as a form-level alert, no field marked invalid", async () => {
    const message = "only a confidential client may be granted the admin resource";
    mocks.create.mockResolvedValue(fail("invalid_request", message) as never);
    renderAt("/clients/new");
    fireEvent.click(await screen.findByRole("radio", { name: /Public/ }));
    const admin = await screen.findByRole("checkbox", { name: /^admin/ });
    expect(admin.closest("label")!.textContent).toMatch(/super_admin only/);
    fireEvent.click(admin);
    type("Redirect URIs", "https://app.example/cb");
    submit("Create client");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(message);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      data: { clientType: "public", tokenEndpointAuthMethod: "none", allowedResources: ["admin"] },
    });
    expect(document.querySelectorAll('[aria-invalid="true"]').length).toBe(0);
  });

  it("tenant_admin granting admin => BE 403 => fixed forbidden alert", async () => {
    mocks.create.mockResolvedValue(fail("forbidden", "You do not have permission to do this.") as never);
    renderAt("/clients/new");
    fireEvent.click(await screen.findByRole("checkbox", { name: /^admin/ }));
    submit("Create client");
    expect((await screen.findByRole("alert")).textContent).toBe("You do not have permission to do this.");
  });
});

describe("state: lost-update variants", () => {
  it("toggle a resource on then off => 'No changes', nothing sent", async () => {
    renderAt("/clients/app-1");
    const demo = await screen.findByRole("checkbox", { name: /^demo/ });
    fireEvent.click(demo);
    fireEvent.click(demo);
    submit("Save changes");
    expect((await within(document.querySelector("form[novalidate]")!).findByRole("status")).textContent).toBe("No changes to save.");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  // DEBT-308 (latent: no detail-to-detail link exists yet, so only history/programmatic navigation
  // reaches it): `$clientId` keeps `EditClient` mounted when the new id's detail is cached, and
  // `ClientForm` (frozen defaults, key "blank") keeps the PREVIOUS client's values and diff base.
  // A save there PATCHes this client with the other client's lists. Flip to `it` once fixed.
  it("switching to another client whose detail is cached shows THAT client's values (no stale form)", async () => {
    const OTHER = { ...CLIENT, clientId: "app-2", redirectUris: ["https://other.example/cb"], scopes: ["openid", "other"] };
    mocks.get.mockImplementation((async ({ data }: { data: string }) => ok(data === "app-2" ? OTHER : CLIENT)) as never);
    const router = renderAt("/clients/app-1");
    await waitFor(() => expect(field("Redirect URIs").value).toBe("https://app.example/cb"));
    await act(() => router.navigate({ to: "/clients/$clientId", params: { clientId: "app-2" } }));
    await waitFor(() => expect(field("Redirect URIs").value).toBe("https://other.example/cb"));
    await act(() => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/clients/app-1"));
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("app-1");
    expect(field("Redirect URIs").value).toBe("https://app.example/cb");
    expect(field("Scopes").value).toBe("openid");
  });
});

// DEBT-330: after an `uncertain` PATCH the diff base is unknown. A field in that PATCH must be sent
// again even when its value equals the mount data (the write may have landed); other fields stay
// out of the PATCH (DEBT-307: nothing the admin did not change is sent).
describe("state: uncertain update then revert (DEBT-330)", () => {
  const uncertain = { ok: false as const, error: { code: "unavailable" as const, message: "x", uncertain: true as const } };
  const formAlert = () => within(document.querySelector("form[novalidate]")!).getByRole("alert");

  async function uncertainThenLanded(edit: () => void, landed: AdminClient) {
    renderAt("/clients/app-1");
    await waitFor(() => expect(field("Redirect URIs").value).toBe("https://app.example/cb"));
    await screen.findByRole("checkbox", { name: /^demo/ });
    mocks.update.mockResolvedValueOnce(uncertain as never);
    mocks.get.mockResolvedValue(ok(landed) as never); // the write did land
    edit();
    submit("Save changes");
    await waitFor(() => expect(formAlert().textContent).toMatch(/result is unknown/));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(1));
    await act(() => new Promise((r) => setTimeout(r, 30)));
    mocks.update.mockResolvedValue(ok(CLIENT) as never);
  }
  const lastPatch = () => (mocks.update.mock.calls.at(-1)![0] as { data: { patch: unknown } }).data.patch;

  it("redirectUris: reverting to the mount value is sent (not 'No changes')", async () => {
    await uncertainThenLanded(() => type("Redirect URIs", "https://evil.example/cb"), {
      ...CLIENT,
      redirectUris: ["https://evil.example/cb"],
    });
    type("Redirect URIs", "https://app.example/cb");
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(lastPatch()).toEqual({ redirectUris: ["https://app.example/cb"] });
  });

  it("allowedResources: unticking back to the mount value is sent (not 'No changes')", async () => {
    await uncertainThenLanded(() => fireEvent.click(screen.getByRole("checkbox", { name: /^demo/ })), {
      ...CLIENT,
      allowedResources: ["demo"],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /^demo/ }));
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(lastPatch()).toEqual({ allowedResources: [] });
  });

  it("saving the same values again re-sends exactly that field; after a confirmed save the base is known again", async () => {
    await uncertainThenLanded(() => type("Scopes", "openid profile"), CLIENT); // did NOT land
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(lastPatch()).toEqual({ scopes: ["openid", "profile"] });
    await act(() => new Promise((r) => setTimeout(r, 30)));
    submit("Save changes"); // saved => the form now shows the saved values: nothing to send
    expect((await within(document.querySelector("form[novalidate]")!).findByRole("status")).textContent).toBe(
      "No changes to save.",
    );
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });
});

describe("a11y: keyboard only", () => {
  it("create with the keyboard: Tab reaches the controls in order, Space toggles, Enter submits", async () => {
    const user = userEvent.setup({ delay: null });
    mocks.create.mockResolvedValue(ok({ ...CLIENT, clientId: "new-1" }) as never);
    const router = renderAt("/clients/new");
    const publicRadio = await screen.findByRole("radio", { name: /Public/ });
    await screen.findByRole("checkbox", { name: /^demo/ });
    publicRadio.focus();
    await user.keyboard(" ");
    expect((publicRadio as HTMLInputElement).checked).toBe(true);
    await user.tab(); // method radio (none)
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "none" }));
    await user.tab(); // grant: authorization code
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Authorization code" }));
    await user.tab();
    await user.keyboard(" "); // refresh token on
    expect((screen.getByRole("checkbox", { name: "Refresh token" }) as HTMLInputElement).checked).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(field("Redirect URIs"));
    await user.paste("https://app.example/cb");
    for (const label of ["Post-logout redirect URIs", "Front-channel logout URI", "Allowed CORS origins"]) {
      await user.tab();
      expect(document.activeElement).toBe(field(label));
    }
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: /^admin/ }));
    await user.tab();
    await user.keyboard(" "); // demo on
    await user.tab();
    expect(document.activeElement).toBe(field("Scopes"));
    await user.keyboard("openid{Enter}");
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      data: {
        clientType: "public",
        grantTypes: ["authorization_code", "refresh_token"],
        redirectUris: ["https://app.example/cb"],
        allowedResources: ["demo"],
        scopes: ["openid"],
      },
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/clients/new-1"));
  }, 20_000);

  it("invalid submit by keyboard moves focus to the first invalid field, whose error is announced via aria-describedby", async () => {
    const user = userEvent.setup({ delay: null });
    renderAt("/clients/new");
    const scopes = await screen.findByLabelText("Scopes");
    type("Post-logout redirect URIs", "http://evil.example/bye");
    type("Allowed CORS origins", "https://app.example/");
    scopes.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(field("Post-logout redirect URIs")));
    const el = field("Post-logout redirect URIs");
    expect(el.getAttribute("aria-invalid")).toBe("true");
    const errorId = el.getAttribute("aria-describedby")!.split(" ").find((id) => id.endsWith("-error"))!;
    expect(document.getElementById(errorId)!.textContent).toMatch(/Line 1: .*https/);
    expect(field("Allowed CORS origins").getAttribute("aria-invalid")).toBe("true");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

// Tester run 46 round 2: the `unknown` field set (DEBT-330 fix) across failure sequences. Invariant:
// the PATCH holds exactly the fields still unknown + the fields changed vs the mount base (`toEqual`,
// so no immutable / untouched field ever appears), until a save is confirmed; a 4xx in between does
// not make a field known; a refetch never overwrites the admin's draft.
describe("state: uncertain update, failure sequences (DEBT-330, round 2)", () => {
  const uncertain = { ok: false as const, error: { code: "unavailable" as const, message: "x", uncertain: true as const } };
  const theForm = () => document.querySelector("form[novalidate]") as HTMLElement;
  const formAlert = () => within(theForm()).getByRole("alert");
  const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
  const lastPatch = () => (mocks.update.mock.calls.at(-1)![0] as { data: { clientId: string; patch: unknown } }).data;
  const EVIL = "https://evil.example/cb";

  async function open() {
    renderAt("/clients/app-1");
    await waitFor(() => expect(field("Redirect URIs").value).toBe("https://app.example/cb"));
    await screen.findByRole("checkbox", { name: /^demo/ });
  }
  async function saveExpecting(alert: RegExp) {
    submit("Save changes");
    await waitFor(() => expect(formAlert().textContent).toMatch(alert));
    await settle();
  }

  it("unknown field + newly changed field are sent together, nothing else; the refetch never overwrites the draft", async () => {
    await open();
    mocks.update.mockResolvedValueOnce(uncertain as never);
    // re-read: the redirect write landed, and someone else changed CORS meanwhile
    mocks.get.mockResolvedValue(
      ok({ ...CLIENT, redirectUris: [EVIL], allowedCorsOrigins: ["https://other.example"] }) as never,
    );
    type("Redirect URIs", EVIL);
    await saveExpecting(/result is unknown/);
    expect(field("Redirect URIs").value).toBe(EVIL);
    expect(field("Allowed CORS origins").value).toBe(""); // draft kept, refetch not applied
    mocks.update.mockResolvedValue(ok(CLIENT) as never);
    type("Redirect URIs", "https://app.example/cb"); // revert
    type("Scopes", "openid email");
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(lastPatch()).toEqual({
      clientId: "app-1",
      patch: { redirectUris: ["https://app.example/cb"], scopes: ["openid", "email"] },
    });
  });

  it("uncertain twice accumulates the unknown fields; a confirmed save clears them ('No changes' again)", async () => {
    await open();
    mocks.update.mockResolvedValueOnce(uncertain as never).mockResolvedValueOnce(uncertain as never);
    type("Redirect URIs", EVIL);
    await saveExpecting(/result is unknown/);
    type("Scopes", "openid admin");
    await saveExpecting(/result is unknown/);
    expect(lastPatch().patch).toEqual({ redirectUris: [EVIL], scopes: ["openid", "admin"] });
    mocks.update.mockResolvedValue(ok(CLIENT) as never);
    type("Redirect URIs", "https://app.example/cb");
    type("Scopes", "openid");
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(3));
    expect(lastPatch().patch).toEqual({ redirectUris: ["https://app.example/cb"], scopes: ["openid"] });
    await settle();
    submit("Save changes");
    expect((await within(theForm()).findByRole("status")).textContent).toBe("No changes to save.");
    expect(mocks.update).toHaveBeenCalledTimes(3);
  });

  it("uncertain, then a 4xx (not uncertain), then save: the unknown field is still sent", async () => {
    await open();
    mocks.update
      .mockResolvedValueOnce(uncertain as never)
      .mockResolvedValueOnce(fail("invalid_request", "redirect rejected") as never);
    type("Redirect URIs", EVIL);
    await saveExpecting(/result is unknown/);
    type("Redirect URIs", "https://app.example/cb");
    await saveExpecting(/redirect rejected/);
    expect(lastPatch().patch).toEqual({ redirectUris: ["https://app.example/cb"] });
    mocks.update.mockResolvedValue(ok(CLIENT) as never);
    submit("Save changes"); // equals the mount base: still unknown => sent
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(3));
    expect(lastPatch().patch).toEqual({ redirectUris: ["https://app.example/cb"] });
  });

  it("a thrown error (network / BFF), then revert: sent", async () => {
    await open();
    mocks.update.mockRejectedValueOnce(new Error("socket hang up"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^admin/ }));
    await saveExpecting(/Something went wrong/);
    mocks.update.mockResolvedValue(ok(CLIENT) as never);
    fireEvent.click(screen.getByRole("checkbox", { name: /^admin/ }));
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(lastPatch().patch).toEqual({ allowedResources: [] });
  });

  it("uncertain that did NOT land: unchanged resubmit re-sends exactly the same values", async () => {
    await open();
    mocks.update.mockResolvedValueOnce(uncertain as never);
    type("Redirect URIs", `${EVIL}\nhttps://app.example/cb`);
    await saveExpecting(/result is unknown/);
    mocks.update.mockResolvedValue(ok(CLIENT) as never);
    submit("Save changes");
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[1]![0]).toEqual(mocks.update.mock.calls[0]![0]);
    expect(lastPatch().patch).toEqual({ redirectUris: [EVIL, "https://app.example/cb"] });
  });
});
