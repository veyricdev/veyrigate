// Tester run 44 (A6.1): UI risk matrix for the clients pages, through the real route tree under
// StrictMode (server fns mocked, same harness as clients-ui.test.tsx):
// - Exposure: stored URIs / BE error text / client id with markup render as text only;
// - Input: tampered step-up drafts never smuggle immutable fields, `disabled` or unknown keys;
// - Authorization (display only): public + admin resource is sent, the BE 400 is a form-level alert;
// - State: lost-update variants (revert, client switch with a cached detail);
// - a11y: keyboard-only create (Tab order, Space on radios/checkboxes, Enter submits).
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByRole("status").textContent).toMatch(/submit again/);
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
    expect((await screen.findByRole("status")).textContent).toBe("No changes to save.");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  // DEBT-308 (latent: no detail-to-detail link exists yet, so only history/programmatic navigation
  // reaches it): `$clientId` keeps `EditClient` mounted when the new id's detail is cached, and
  // `ClientForm` (frozen defaults, key "blank") keeps the PREVIOUS client's values and diff base.
  // A save there PATCHes this client with the other client's lists. Flip to `it` once fixed.
  it.fails("switching to another client whose detail is cached shows THAT client's values (no stale form)", async () => {
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
