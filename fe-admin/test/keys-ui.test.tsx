// Run 49 (A6.5) signing keys UI through the real route tree under StrictMode (server fns mocked),
// rendered into `document` (DEBT-312: Radix AlertDialogs). super_admin gate (no call otherwise),
// metadata table as text, normal rotation, emergency rotation behind the typed EMERGENCY step and
// the Q-49.1 warning, uncertain never re-sent (kid comparison), step-up without intent.
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { listSigningKeys, rotateSigningKey } from "@/features/admin-api/signing-keys";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AdminApiErrorCode } from "@/features/admin-api/types";
import type { SigningKey } from "@/server/admin-api/schemas";

vi.mock("@/features/theme/ui-prefs", () => ({ getUiPrefs: vi.fn() }));
vi.mock("@/features/auth/viewer", () => ({ getViewer: vi.fn() }));
vi.mock("@/lib/route-boundary", () => ({ safely: (_where: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/features/admin-api/signing-keys", () => ({ listSigningKeys: vi.fn(), rotateSigningKey: vi.fn() }));

const list = vi.mocked(listSigningKeys);
const rotate = vi.mocked(rotateSigningKey);

const K1 = "kid-one-2026";
const K0 = "kid-zero-2026";
const ACTIVE: SigningKey = { kid: K1, alg: "RS256", status: "active", createdAt: "2026-10-23T01:00:00.000Z", retireAt: null };
const RETIRING_LATE: SigningKey = { kid: "kid-late", alg: "RS256", status: "retiring", createdAt: "2026-10-22T00:00:00.000Z", retireAt: "2026-10-23T01:05:00.000Z" };
const RETIRING: SigningKey = { kid: K0, alg: "RS256", status: "retiring", createdAt: "2026-10-21T00:00:00.000Z", retireAt: "2026-10-23T01:02:00.000Z" };
const SUPER = { sub: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "admin@example.com", roles: ["super_admin"], tenantId: "t1" };
const TENANT_ADMIN = { ...SUPER, roles: ["tenant_admin"] };
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: AdminApiErrorCode, uncertain = false) => ({
  ok: false as const,
  error: { code, message: `msg ${code}`, ...(uncertain ? { uncertain: true as const } : {}) },
});

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue(SUPER);
  list.mockResolvedValue(ok({ items: [RETIRING_LATE, ACTIVE, RETIRING], nextCursor: null }) as never);
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
const dialog = () => screen.findByRole("alertdialog");
const noDialog = () => waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
const status = () => within(screen.getByRole("region", { name: "Rotation" })).getByRole("status");
const openPage = async () => {
  renderAt("/keys");
  await screen.findByRole("table", { name: "Signing keys" });
};
async function open(trigger: string) {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  return dialog();
}
const typeIn = (d: HTMLElement, value: string) =>
  fireEvent.change(within(d).getByLabelText("Type EMERGENCY to confirm"), { target: { value } });

describe("gate", () => {
  it("tenant_admin: fixed text, no table, no button, the server fns are never called", async () => {
    vi.mocked(getViewer).mockResolvedValue(TENANT_ADMIN);
    renderAt("/keys");
    expect(await screen.findByText("Only a super_admin can view and rotate signing keys.")).toBeTruthy();
    await settle();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /rotat/i })).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
  });
});

describe("table", () => {
  it("metadata as text: active first, then retiring by retireAt; '—' for no retireAt; nav entry", async () => {
    await openPage();
    const table = screen.getByRole("table", { name: "Signing keys" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Key ID", "Algorithm", "Status", "Created", "Retires at"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual([K1, K0, "kid-late"]);
    expect(within(rows[0]!).getByText("Active — signs new tokens")).toBeTruthy();
    expect(within(rows[0]!).getByText("—")).toBeTruthy();
    expect(within(rows[1]!).getByText("Retiring — verification only")).toBeTruthy();
    expect(within(rows[1]!).getByText("2026-10-23T01:02:00.000Z")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("navigation", { name: "Main" }).querySelector('a[href="/keys"]')).not.toBeNull();
  });

  it("a hostile kid is rendered as text (no element created)", async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    list.mockResolvedValue(ok({ items: [{ ...ACTIVE, kid: evil }], nextCursor: null }) as never);
    await openPage();
    expect(screen.getByText(evil)).toBeTruthy();
    expect(document.querySelector("table img")).toBeNull();
  });

  it("read error: message + Try again", async () => {
    list.mockResolvedValue(fail("forbidden") as never);
    renderAt("/keys");
    expect((await screen.findByRole("alert")).textContent).toContain("msg forbidden");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("normal rotation", () => {
  it("confirm => {mode:'normal'} once, result announced, list re-read", async () => {
    rotate.mockResolvedValue(ok({ newKid: "kid-two", oldKid: K1, mode: "normal" }) as never);
    await openPage();
    const d = await open("Rotate key");
    expect(d.textContent).toContain("Nobody is signed out.");
    fireEvent.click(within(d).getByRole("button", { name: "Rotate key" }));
    await noDialog();
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(rotate).toHaveBeenCalledWith({ data: { mode: "normal" } });
    await waitFor(() => expect(status().textContent).toBe(`Rotated. New active key kid-two; ${K1} is now verification only.`));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("oldKid null: no second clause", async () => {
    rotate.mockResolvedValue(ok({ newKid: "kid-two", oldKid: null, mode: "normal" }) as never);
    await openPage();
    fireEvent.click(within(await open("Rotate key")).getByRole("button", { name: "Rotate key" }));
    await waitFor(() => expect(status().textContent).toBe("Rotated. New active key kid-two."));
  });
});

describe("emergency rotation", () => {
  it("the warning states the real consequences only (Q-49.1) and links the audit log", async () => {
    await openPage();
    const d = await open("Emergency rotation…");
    const alert = within(d).getByRole("alert");
    const text = alert.textContent ?? "";
    expect(text).toMatch(/Every access token and ID token issued before the rotation is rejected by the IdP at once/);
    expect(text).toMatch(/including this console/);
    expect(text).toMatch(/tell them to refetch JWKS/);
    expect(text).toMatch(/Refresh tokens and IdP sessions are not revoked/);
    expect(text).toMatch(/id_token_hint issued before the rotation does not return to the application/);
    expect(text).toMatch(/There is no rollback\./);
    expect(text).toMatch(/This console's session will be refreshed; you may be asked to sign in again\./);
    expect(alert.querySelectorAll("li")).toHaveLength(5);
    expect(d.textContent).not.toMatch(/(all|every) users? (are|is|will be) signed out|refresh tokens? (are|is|will be) revoked|15 min/i);
    expect(within(alert).getByRole("link").getAttribute("href")).toBe("/audit?action=SIGNING_KEY_ROTATED");
  });

  it("confirm stays disabled until exactly EMERGENCY is typed; sends {mode:'emergency'} once on a double click", async () => {
    rotate.mockResolvedValue(ok({ newKid: "kid-new", oldKid: K1, mode: "emergency" }) as never);
    await openPage();
    const d = await open("Emergency rotation…");
    const confirm = within(d).getByRole("button", { name: "Rotate now" }) as HTMLButtonElement;
    for (const v of ["", "emergency", " EMERGENCY", "EMERGENCY ", "EMERGENC", "Emergency"]) {
      typeIn(d, v);
      expect(confirm.disabled).toBe(true);
      fireEvent.click(confirm);
    }
    expect(rotate).not.toHaveBeenCalled();
    typeIn(d, "EMERGENCY");
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await noDialog();
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(rotate).toHaveBeenCalledWith({ data: { mode: "emergency" } });
    await waitFor(() =>
      expect(status().textContent).toBe(
        "Emergency rotation done. New active key kid-new. Previous keys were removed from JWKS. Tell relying parties to refetch JWKS.",
      ),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("Cancel clears the typed text; reopening starts empty and disabled", async () => {
    await openPage();
    let d = await open("Emergency rotation…");
    typeIn(d, "EMERGENCY");
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await noDialog();
    d = await open("Emergency rotation…");
    expect((within(d).getByLabelText("Type EMERGENCY to confirm") as HTMLInputElement).value).toBe("");
    expect((within(d).getByRole("button", { name: "Rotate now" }) as HTMLButtonElement).disabled).toBe(true);
    expect(rotate).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it.each([
    ["uncertain", () => Promise.resolve(fail("unavailable", true))],
    ["thrown (network / BFF)", () => Promise.reject(new Error("boom"))],
  ])("%s: dialog closes, kid comparison announced, never re-sent, list re-read", async (_, impl) => {
    rotate.mockImplementation(impl as never);
    await openPage();
    const d = await open("Emergency rotation…");
    typeIn(d, "EMERGENCY");
    fireEvent.click(within(d).getByRole("button", { name: "Rotate now" }));
    await noDialog();
    await waitFor(() =>
      expect(status().textContent).toBe(
        `The result is unknown and the request was not sent again. The key list has been reloaded: if the active key is no longer ${K1}, the rotation was applied — do not rotate again.`,
      ),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await settle();
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it("step_up_required: Confirm identity shown in the dialog, nothing re-sent", async () => {
    rotate.mockResolvedValue(fail("step_up_required") as never);
    await openPage();
    const d = await open("Rotate key");
    fireEvent.click(within(d).getByRole("button", { name: "Rotate key" }));
    expect(await within(d).findByRole("button", { name: "Confirm identity" })).toBeTruthy();
    await settle();
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1); // a known refusal changed nothing
  });

  it("forbidden: fixed text in the dialog", async () => {
    rotate.mockResolvedValue(fail("forbidden") as never);
    await openPage();
    const d = await open("Rotate key");
    fireEvent.click(within(d).getByRole("button", { name: "Rotate key" }));
    expect((await within(d).findByRole("alert")).textContent).toBe("Only a super_admin can rotate signing keys.");
    expect(rotate).toHaveBeenCalledTimes(1);
  });
});
