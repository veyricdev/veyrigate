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
const ACTIVE: SigningKey = { kid: K1, alg: "RS256", status: "active", createdAt: "2026-10-23T01:00:00.000Z", activatesAt: "2026-10-23T01:00:00.000Z", retireAt: null };
const RETIRING_LATE: SigningKey = { kid: "kid-late", alg: "RS256", status: "retiring", createdAt: "2026-10-22T00:00:00.000Z", activatesAt: "2026-10-22T00:00:00.000Z", retireAt: "2026-10-23T01:05:00.000Z" };
const RETIRING: SigningKey = { kid: K0, alg: "RS256", status: "retiring", createdAt: "2026-10-21T00:00:00.000Z", activatesAt: "2026-10-21T00:00:00.000Z", retireAt: "2026-10-23T01:02:00.000Z" };
// Two pending keys only happen after a Vault race (D86.10); listed by activatesAt (soonest first).
const PENDING_LATE: SigningKey = { kid: "kid-next-late", alg: "RS256", status: "pending", createdAt: "2026-10-23T01:01:00.000Z", activatesAt: "2026-10-23T02:01:00.000Z", retireAt: null };
const PENDING: SigningKey = { kid: "kid-next", alg: "RS256", status: "pending", createdAt: "2026-10-23T01:01:30.000Z", activatesAt: "2026-10-23T02:00:30.000Z", retireAt: null };
const AT = "2026-10-23T02:00:00.000Z";
const CONFLICT_TEXT = "A newer signing key is already published and does not sign yet. Wait until it activates, or use an emergency rotation.";
const PENDING_HINT = "A new key is already published and does not sign yet. Rotate again after it activates, or use an emergency rotation.";
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

  it("pending (DEBT-393): active, then pending by activatesAt, then retiring by retireAt; label carries activatesAt", async () => {
    list.mockResolvedValue(ok({ items: [RETIRING_LATE, PENDING_LATE, RETIRING, ACTIVE, PENDING], nextCursor: null }) as never);
    await openPage();
    const rows = within(screen.getByRole("table", { name: "Signing keys" })).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual([K1, "kid-next", "kid-next-late", K0, "kid-late"]);
    expect(within(rows[1]!).getByText(`Pending — published, signs from ${PENDING.activatesAt}`)).toBeTruthy();
    expect(within(rows[2]!).getByText(`Pending — published, signs from ${PENDING_LATE.activatesAt}`)).toBeTruthy();
    expect(within(rows[1]!).getByText("—")).toBeTruthy();
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
    rotate.mockResolvedValue(ok({ newKid: "kid-two", oldKid: K1, mode: "normal", activatesAt: AT }) as never);
    await openPage();
    const d = await open("Rotate key");
    expect(d.textContent).toContain(
      "The new key is published at once and starts signing after the pre-publish delay (KEY_PREPUBLISH_SEC, default 1 hour). Until then the current key keeps signing.",
    );
    expect(d.textContent).toContain("Nobody is signed out.");
    fireEvent.click(within(d).getByRole("button", { name: "Rotate key" }));
    await noDialog();
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(rotate).toHaveBeenCalledWith({ data: { mode: "normal" } });
    await waitFor(() =>
      expect(status().textContent).toBe(
        `Rotated. New key kid-two is published and signs from ${AT}. ${K1} keeps signing until then, then is verification only.`,
      ),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("oldKid null: no second sentence", async () => {
    rotate.mockResolvedValue(ok({ newKid: "kid-two", oldKid: null, mode: "normal", activatesAt: AT }) as never);
    await openPage();
    fireEvent.click(within(await open("Rotate key")).getByRole("button", { name: "Rotate key" }));
    await waitFor(() => expect(status().textContent).toBe(`Rotated. New key kid-two is published and signs from ${AT}.`));
  });

  it("a pending key: normal Rotate disabled with the reason, no call; emergency still opens", async () => {
    list.mockResolvedValue(ok({ items: [ACTIVE, PENDING, RETIRING], nextCursor: null }) as never);
    await openPage();
    const button = screen.getByRole("button", { name: "Rotate key" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(screen.getByRole("region", { name: "Rotation" })).getByText(PENDING_HINT)).toBeTruthy();
    fireEvent.click(button);
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(rotate).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Emergency rotation…" }) as HTMLButtonElement).disabled).toBe(false);
    expect(await open("Emergency rotation…")).toBeTruthy();
  });

  it("no pending key: normal Rotate enabled, no reason shown", async () => {
    await openPage();
    expect((screen.getByRole("button", { name: "Rotate key" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(PENDING_HINT)).toBeNull();
  });

  it("409 conflict (a race with another rotation): fixed text in the dialog, never re-sent, list re-read", async () => {
    rotate.mockResolvedValue(fail("conflict") as never);
    await openPage();
    const d = await open("Rotate key");
    list.mockResolvedValue(ok({ items: [ACTIVE, PENDING, RETIRING], nextCursor: null }) as never);
    fireEvent.click(within(d).getByRole("button", { name: "Rotate key" }));
    expect((await within(d).findByRole("alert")).textContent).toBe(CONFLICT_TEXT);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await settle();
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(d.textContent).not.toContain("msg conflict");
    expect(d.textContent).not.toContain("The result is unknown");
  });

  it.each([
    ["uncertain", () => Promise.resolve(fail("unavailable", true))],
    ["thrown (network / BFF)", () => Promise.reject(new Error("boom"))],
  ])("%s: compares the set of kids (the active kid does not change), never re-sent, list re-read", async (_, impl) => {
    rotate.mockImplementation(impl as never);
    await openPage();
    fireEvent.click(within(await open("Rotate key")).getByRole("button", { name: "Rotate key" }));
    await noDialog();
    await waitFor(() =>
      expect(status().textContent).toBe(
        `The result is unknown and the request was not sent again. The key list has been reloaded. Keys before the request: kid-late, ${K1}, ${K0}. If the list now has a key that was not there before (pending or active), the rotation was applied — do not rotate again.`,
      ),
    );
    expect(status().textContent).not.toContain("if the active key is no longer");
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await settle();
    expect(rotate).toHaveBeenCalledTimes(1);
  });
});

describe("pending key activation (DEBT-606)", () => {
  const ACTIVATED: SigningKey[] = [
    { ...PENDING, status: "active" },
    { ...ACTIVE, status: "retiring", retireAt: "2026-10-23T02:10:30.000Z" },
  ];

  it("the list is re-read once the earliest activatesAt passes: row Active, Rotate enabled, no reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse(PENDING.activatesAt) - 60_000 });
    try {
      list
        .mockResolvedValueOnce(ok({ items: [ACTIVE, PENDING_LATE, PENDING], nextCursor: null }) as never)
        .mockResolvedValue(ok({ items: [...ACTIVATED, PENDING_LATE], nextCursor: null }) as never);
      await openPage();
      expect((screen.getByRole("button", { name: "Rotate key" }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(55_000);
      });
      expect(list).toHaveBeenCalledTimes(1); // not before the instant
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      const row = within(screen.getByRole("table", { name: "Signing keys" }))
        .getAllByRole("row")
        .find((r) => r.querySelector("th")?.textContent === PENDING.kid)!;
      expect(within(row).getByText("Active — signs new tokens")).toBeTruthy();
      // PENDING_LATE still pending (a Vault race leftover): still disabled, next re-read at its instant.
      expect((screen.getByRole("button", { name: "Rotate key" }) as HTMLButtonElement).disabled).toBe(true);
      list.mockResolvedValue(ok({ items: [{ ...PENDING_LATE, status: "active" }, ...ACTIVATED], nextCursor: null }) as never);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(Date.parse(PENDING_LATE.activatesAt) - Date.parse(PENDING.activatesAt) + 5_000);
      });
      await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
      await waitFor(() => expect((screen.getByRole("button", { name: "Rotate key" }) as HTMLButtonElement).disabled).toBe(false));
      expect(screen.queryByText(PENDING_HINT)).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });
      expect(list).toHaveBeenCalledTimes(3); // nothing pending: no polling
    } finally {
      vi.useRealTimers();
    }
  });

  it("BE clock behind: still pending at the instant => re-read again shortly, then Active", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse(PENDING.activatesAt) - 10_000 });
    try {
      const stillPending = ok({ items: [ACTIVE, PENDING], nextCursor: null });
      list
        .mockResolvedValueOnce(stillPending as never)
        .mockResolvedValueOnce(stillPending as never)
        .mockResolvedValue(ok({ items: ACTIVATED, nextCursor: null }) as never);
      await openPage();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_500);
      });
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
      await waitFor(() => expect((screen.getByRole("button", { name: "Rotate key" }) as HTMLButtonElement).disabled).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it("no pending key: read once, no timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openPage();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      });
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
    rotate.mockResolvedValue(ok({ newKid: "kid-new", oldKid: K1, mode: "emergency", activatesAt: AT }) as never);
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
