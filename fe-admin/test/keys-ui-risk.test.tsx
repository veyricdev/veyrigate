// Run 49 (A6.5) tester risk matrix for /keys, beyond keys-ui.test.tsx: the typed EMERGENCY gate
// against look-alikes / paste / Enter / pending edits, role-gate variants and in-app navigation,
// key material that a regressed BFF would let through (DOM, query cache, notices), step-up keeps
// no trace of the typed text / mode, the uncertain message without a loaded list, the stale
// `kidBefore` characterisation (senior nit), and no false statement in either dialog.
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { listSigningKeys, rotateSigningKey } from "@/features/admin-api/signing-keys";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AdminApiErrorCode } from "@/features/admin-api/types";
import { RotateKeyResultSchema, SigningKeyListSchema, type SigningKey } from "@/server/admin-api/schemas";

vi.mock("@/features/theme/ui-prefs", () => ({ getUiPrefs: vi.fn() }));
vi.mock("@/features/auth/viewer", () => ({ getViewer: vi.fn() }));
vi.mock("@/lib/route-boundary", () => ({ safely: (_where: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/features/admin-api/signing-keys", () => ({ listSigningKeys: vi.fn(), rotateSigningKey: vi.fn() }));

const list = vi.mocked(listSigningKeys);
const rotate = vi.mocked(rotateSigningKey);

const K1 = "kid-one-2026";
const K2 = "kid-two-2026";
const ACTIVE: SigningKey = { kid: K1, alg: "RS256", status: "active", createdAt: "2026-10-23T01:00:00.000Z", retireAt: null };
const SUPER = { sub: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "admin@example.com", roles: ["super_admin"], tenantId: "t1" };
const MATERIAL = {
  kty: "RSA",
  n: "MATERIAL-n",
  e: "AQAB",
  d: "MATERIAL-d",
  p: "MATERIAL-p",
  q: "MATERIAL-q",
  pem: "-----BEGIN PRIVATE KEY-----MATERIAL",
  path: "/srv/keys/MATERIAL.pem",
  privateKey: "MATERIAL-private",
};
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: AdminApiErrorCode, uncertain = false) => ({
  ok: false as const,
  error: { code, message: `msg ${code}`, ...(uncertain ? { uncertain: true as const } : {}) },
});

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sessionStorage.clear();
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue(SUPER);
  list.mockResolvedValue(ok({ items: [ACTIVE], nextCursor: null }) as never);
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
  return { router, queryClient: queryClient as QueryClient };
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
const dialog = () => screen.findByRole("alertdialog");
const noDialog = () => waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
const status = () => within(screen.getByRole("region", { name: "Rotation" })).getByRole("status");
const openPage = async () => {
  const r = renderAt("/keys");
  await screen.findByRole("table", { name: "Signing keys" });
  return r;
};
async function open(trigger: string) {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  return dialog();
}
const box = (d: HTMLElement) => within(d).getByLabelText("Type EMERGENCY to confirm") as HTMLInputElement;
const confirmBtn = (d: HTMLElement) => within(d).getByRole("button", { name: "Rotate now" }) as HTMLButtonElement;

describe("EMERGENCY gate — look-alikes and input paths", () => {
  it.each([
    ["Cyrillic Е", "\u0415MERGENCY"],
    ["Greek Μ", "E\u039CERGENCY"],
    ["full-width", "\uFF25\uFF2D\uFF25\uFF32\uFF27\uFF25\uFF2E\uFF23\uFF39"],
    ["zero-width space suffix", "EMERGENCY\u200B"],
    ["zero-width joiner inside", "EMER\u200DGENCY"],
    ["NBSP suffix", "EMERGENCY\u00A0"],
    ["tab prefix", "\tEMERGENCY"],
    ["lower case", "emergency"],
    ["leading space", " EMERGENCY"],
    ["doubled", "EMERGENCYEMERGENCY"],
    ["dotted capital I look-alike", "\u0130MERGENCY"],
  ])("%s: confirm disabled, a click and Enter send nothing", async (_n, value) => {
    await openPage();
    const d = await open("Emergency rotation…");
    fireEvent.change(box(d), { target: { value } });
    expect(box(d).value).toBe(value);
    expect(confirmBtn(d).disabled).toBe(true);
    fireEvent.click(confirmBtn(d));
    fireEvent.keyDown(box(d), { key: "Enter", code: "Enter" });
    await settle();
    expect(rotate).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("paste (user-event): ' EMERGENCY' stays disabled; pasting exactly EMERGENCY enables; Enter in the box never submits", async () => {
    rotate.mockResolvedValue(ok({ newKid: K2, oldKid: K1, mode: "emergency" }) as never);
    const user = userEvent.setup({ delay: null });
    await openPage();
    const d = await open("Emergency rotation…");
    await user.click(box(d));
    await user.paste(" EMERGENCY");
    expect(confirmBtn(d).disabled).toBe(true);
    await user.keyboard("{Enter}");
    await user.clear(box(d));
    await user.paste("EMERGENCY");
    expect(confirmBtn(d).disabled).toBe(false);
    await user.keyboard("{Enter}"); // not in a <form>: Enter is not a confirmation
    await settle();
    expect(rotate).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("typed keystroke by keystroke: disabled until the last letter, then one explicit click sends once", async () => {
    rotate.mockResolvedValue(ok({ newKid: K2, oldKid: K1, mode: "emergency" }) as never);
    const user = userEvent.setup({ delay: null });
    await openPage();
    const d = await open("Emergency rotation…");
    await user.click(box(d));
    for (const ch of "EMERGENC") {
      await user.keyboard(ch);
      expect(confirmBtn(d).disabled).toBe(true);
    }
    await user.keyboard("Y");
    expect(confirmBtn(d).disabled).toBe(false);
    await user.dblClick(confirmBtn(d));
    await noDialog();
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(rotate).toHaveBeenCalledWith({ data: { mode: "emergency" } });
  }, 15_000);

  it("while pending: box and buttons disabled, Escape does not close, editing the text cannot re-arm a second send", async () => {
    let release!: (v: unknown) => void;
    rotate.mockImplementation(() => new Promise((r) => (release = r)) as never);
    await openPage();
    const d = await open("Emergency rotation…");
    fireEvent.change(box(d), { target: { value: "EMERGENCY" } });
    fireEvent.click(confirmBtn(d));
    await waitFor(() => expect(within(d).getByRole("button", { name: "Working…" })).toBeTruthy());
    expect(box(d).disabled).toBe(true);
    expect((within(d).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(d, { key: "Escape", code: "Escape" });
    fireEvent.click(within(d).getByRole("button", { name: "Working…" }));
    await settle();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(rotate).toHaveBeenCalledTimes(1);
    await act(async () => release(ok({ newKid: K2, oldKid: K1, mode: "emergency" })));
    await noDialog();
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it("the normal rotation dialog has no typed step (one click confirms) and never sends emergency", async () => {
    rotate.mockResolvedValue(ok({ newKid: K2, oldKid: K1, mode: "normal" }) as never);
    await openPage();
    const d = await open("Rotate key");
    expect(within(d).queryByLabelText("Type EMERGENCY to confirm")).toBeNull();
    fireEvent.click(within(d).getByRole("button", { name: "Rotate key" }));
    await noDialog();
    expect(rotate.mock.calls).toEqual([[{ data: { mode: "normal" } }]]);
  });
});

describe("role gate — variants and in-app navigation", () => {
  it.each([
    ["tenant_admin + admin", ["tenant_admin", "admin"]],
    ["case variant (app gate)", ["SUPER_ADMIN"]],
    ["no role (app gate)", []],
    // tenant_admin passes the app gate, so these exercise the page's exact super_admin check
    ["tenant_admin + case variant", ["tenant_admin", "SUPER_ADMIN"]],
    ["tenant_admin + padded", ["tenant_admin", " super_admin"]],
    ["tenant_admin + prefix", ["tenant_admin", "super_admin_x"]],
  ])("%s: no table/rotate buttons, no server call (app gate or page gate)", async (_n, roles) => {
    vi.mocked(getViewer).mockResolvedValue({ ...SUPER, roles });
    renderAt("/keys");
    await settle();
    await settle();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /rotat/i })).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("tenant_admin navigating in-app from / to /keys: still no server call", async () => {
    vi.mocked(getViewer).mockResolvedValue({ ...SUPER, roles: ["tenant_admin"] });
    const { router } = renderAt("/");
    await settle();
    await act(() => router.navigate({ to: "/keys" }));
    expect(await screen.findByText("Only a super_admin can view and rotate signing keys.")).toBeTruthy();
    await settle();
    expect(list).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
  });
});

describe("key material — defence in depth", () => {
  it("a BFF regression passing extra members through: DOM shows only the 5 metadata fields", async () => {
    list.mockResolvedValue(ok({ items: [{ ...ACTIVE, ...MATERIAL }], nextCursor: null }) as never);
    await openPage();
    expect(document.body.textContent).not.toMatch(/MATERIAL|BEGIN|AQAB/);
    expect(document.body.innerHTML).not.toMatch(/MATERIAL|BEGIN/);
  });

  it("real response schemas between a material-carrying BE and the UI: query cache and DOM hold no material", async () => {
    // The server fn returns what the BFF schema keeps (`call` parses with these exact schemas).
    list.mockImplementation((async () => ok(SigningKeyListSchema.parse({ items: [{ ...ACTIVE, ...MATERIAL }], nextCursor: null }))) as never);
    rotate.mockImplementation((async () => ok(RotateKeyResultSchema.parse({ newKid: K2, oldKid: K1, mode: "normal", ...MATERIAL }))) as never);
    const { queryClient } = await openPage();
    fireEvent.click(within(await open("Rotate key")).getByRole("button", { name: "Rotate key" }));
    await waitFor(() => expect(status().textContent).toContain(K2));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    const cache = JSON.stringify([
      queryClient.getQueryCache().getAll().map((q) => q.state.data),
      queryClient.getMutationCache().getAll().map((m) => m.state.data),
    ]);
    expect(cache).toContain(K1);
    expect(cache).not.toMatch(/MATERIAL|BEGIN|AQAB|"d":|"n":/);
    expect(document.body.textContent).not.toMatch(/MATERIAL|BEGIN|AQAB/);
  });

  it("a regressed rotate result with extra members: the notice shows only newKid/oldKid", async () => {
    rotate.mockResolvedValue(ok({ newKid: K2, oldKid: K1, mode: "normal", ...MATERIAL }) as never);
    await openPage();
    fireEvent.click(within(await open("Rotate key")).getByRole("button", { name: "Rotate key" }));
    await waitFor(() => expect(status().textContent).toBe(`Rotated. New active key ${K2}; ${K1} is now verification only.`));
    expect(document.body.textContent).not.toMatch(/MATERIAL|BEGIN/);
  });
});

describe("step-up keeps no trace", () => {
  it("emergency step_up_required => Confirm identity: returnTo is /keys, no mode / typed text in URL or storage; nothing re-sent", async () => {
    rotate.mockResolvedValue(fail("step_up_required") as never);
    await openPage();
    const d = await open("Emergency rotation…");
    fireEvent.change(box(d), { target: { value: "EMERGENCY" } });
    fireEvent.click(confirmBtn(d));
    fireEvent.click(await within(d).findByRole("button", { name: "Confirm identity" }));
    expect(assign).toHaveBeenCalledTimes(1);
    const url = String(assign.mock.calls[0]![0]);
    expect(url).toBe(`/auth/login?stepup=1&returnTo=${encodeURIComponent("/keys")}`);
    expect(url).not.toMatch(/emergency|mode|kid/i);
    const stored = JSON.stringify({ ...sessionStorage });
    expect(stored).not.toMatch(/emergency|EMERGENCY|mode/);
    await settle();
    expect(rotate).toHaveBeenCalledTimes(1);
  });
});

describe("uncertain outcome", () => {
  it("list not loaded yet (no kidBefore): stays 'Working…' until that read settles, then a generic message without a kid clause, never re-sent", async () => {
    // First read still in flight (no kidBefore). Characterisation: react-query dedupes the
    // post-rotation invalidate onto that in-flight read (no data yet => not cancelled), and
    // `onSettled` awaits it, so the dialog closes only when the read settles (BFF timeout bounds it).
    let settleRead!: (v: unknown) => void;
    list.mockImplementationOnce(() => new Promise((r) => (settleRead = r)) as never);
    rotate.mockResolvedValue(fail("unavailable", true) as never);
    renderAt("/keys");
    await screen.findByRole("button", { name: "Rotate key" });
    const d = await open("Rotate key");
    fireEvent.click(within(d).getByRole("button", { name: "Rotate key" }));
    await waitFor(() => expect(rotate).toHaveBeenCalledTimes(1));
    await settle();
    expect(within(d).getByRole("button", { name: "Working…" })).toBeTruthy();
    await act(async () => settleRead(fail("unavailable", true)));
    await noDialog();
    await waitFor(() =>
      expect(status().textContent).toBe("The result is unknown and the request was not sent again. The key list has been reloaded."),
    );
    await settle();
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it("characterisation (senior nit): kidBefore comes from the cached list; if another admin rotated meanwhile and ours did NOT apply, the message still points at the stale kid", async () => {
    // Cache: K1 active. Truth at click time: another admin already rotated normally (K2 active, K1 retiring).
    list
      .mockResolvedValueOnce(ok({ items: [ACTIVE], nextCursor: null }) as never)
      .mockResolvedValue(
        ok({
          items: [
            { kid: K2, alg: "RS256", status: "active", createdAt: "2026-10-23T01:01:00.000Z", retireAt: null },
            { ...ACTIVE, status: "retiring", retireAt: "2026-10-23T01:03:00.000Z" },
          ],
          nextCursor: null,
        }) as never,
      );
    rotate.mockResolvedValue(fail("unavailable", true) as never); // our emergency call: unknown (in truth not applied)
    await openPage();
    const d = await open("Emergency rotation…");
    fireEvent.change(box(d), { target: { value: "EMERGENCY" } });
    fireEvent.click(confirmBtn(d));
    await noDialog();
    await waitFor(() => expect(status().textContent).toContain(`if the active key is no longer ${K1}, the rotation was applied`));
    // Reloaded list: K2 active AND K1 still listed (retiring). An emergency rotation would have
    // left exactly one key, so the list itself still contradicts "applied" — detectable, not silent.
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Signing keys" })).getAllByRole("row")).toHaveLength(3));
    expect(rotate).toHaveBeenCalledTimes(1);
  });
});

describe("no false statement in either dialog", () => {
  const FALSE =
    /(all|every|any) (users?|people|sessions?)[^.]*(signed|logged) out|refresh tokens? (are|is|will be|get) (revoked|invalidated)|sessions? (are|is|will be) (revoked|terminated|ended)|users? (are|is|will be) (signed|logged) out|\b15\b|minutes?|can be (undone|rolled back)|rollback is possible/i;
  it.each(["Rotate key", "Emergency rotation…"])("%s dialog", async (trigger) => {
    await openPage();
    const d = await open(trigger);
    expect(d.textContent).not.toMatch(FALSE);
  });
});
