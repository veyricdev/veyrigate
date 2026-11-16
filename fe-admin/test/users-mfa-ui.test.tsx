// Run 89 T5: two-step verification state in the users list and the user detail, and the Reset
// two-step verification write (POST /admin/users/{id}/mfa/reset) through the real route tree under
// StrictMode (server fns mocked): shown only for an enrolled user the viewer may change, the
// consequences in the dialog, step-up without intent, uncertain never re-sent, fixed 403/404 text.
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { getUser, listUserConsents, listUserFamilies, listUsers, resetUserMfa } from "@/features/admin-api/users";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AdminApiErrorCode } from "@/features/admin-api/types";
import { MFA_RESET_SELF_UNCERTAIN, MFA_RESET_UNCERTAIN, mfaStatus } from "@/features/users/user-account";
import type { AdminUser } from "@/server/admin-api/schemas";

vi.mock("@/features/theme/ui-prefs", () => ({ getUiPrefs: vi.fn() }));
vi.mock("@/features/auth/viewer", () => ({ getViewer: vi.fn() }));
vi.mock("@/lib/route-boundary", () => ({ safely: (_where: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/features/admin-api/users", () => ({
  listUsers: vi.fn(),
  getUser: vi.fn(),
  listUserFamilies: vi.fn(),
  listUserConsents: vi.fn(),
  lockUser: vi.fn(),
  unlockUser: vi.fn(),
  revokeUserSessions: vi.fn(),
  revokeUserFamily: vi.fn(),
  revokeUserConsent: vi.fn(),
  resetUserMfa: vi.fn(),
  setUserRoles: vi.fn(),
}));

const reset = vi.mocked(resetUserMfa);
const get = vi.mocked(getUser);
const ID = "0123456789abcdef01234567";
const EMAIL = "target.canary@example.com";
const SINCE = "2026-10-05T08:09:10.000Z";
const OFF: AdminUser = {
  id: ID,
  email: EMAIL,
  emailVerified: true,
  locked: false,
  lockedUntil: null,
  membershipStatus: "active",
  roles: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  mfa: { enrolled: false, enrolledAt: null },
};
const ON: AdminUser = { ...OFF, mfa: { enrolled: true, enrolledAt: SINCE } };
const SUPER = { sub: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "admin@example.com", roles: ["super_admin"], tenantId: "t1" };
const TENANT_ADMIN = { ...SUPER, roles: ["tenant_admin"] };
const RESET = "Reset two-step verification";
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: AdminApiErrorCode, uncertain = false) => ({
  ok: false as const,
  error: { code, message: `msg ${code}`, ...(uncertain ? { uncertain: true as const } : {}) },
});

let assign: ReturnType<typeof vi.fn>;
let user: AdminUser;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue(SUPER);
  user = ON;
  vi.mocked(listUsers).mockResolvedValue(ok({ items: [ON, { ...OFF, id: "b".repeat(24), email: "off@example.com" }], nextCursor: null }) as never);
  get.mockImplementation((async () => ok(user)) as never);
  vi.mocked(listUserFamilies).mockResolvedValue(ok({ items: [], nextCursor: null }) as never);
  vi.mocked(listUserConsents).mockResolvedValue(ok({ items: [], nextCursor: null }) as never);
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
const statusOf = () => within(screen.getByRole("region", { name: "Account" })).getByRole("status");
const resetButton = () => screen.queryByRole("button", { name: RESET });
const openDetail = async () => {
  renderAt(`/users/${ID}`);
  await screen.findByText(EMAIL);
};
async function confirmReset(clicks = 1) {
  fireEvent.click(resetButton()!);
  const d = await dialog();
  const confirm = within(d).getByRole("button", { name: "Reset" });
  for (let i = 0; i < clicks; i++) fireEvent.click(confirm);
  return d;
}

describe("mfaStatus (ISO text, no locale)", () => {
  it.each([
    [{ enrolled: true, enrolledAt: SINCE }, `On (since ${SINCE})`],
    [{ enrolled: true, enrolledAt: null }, "On"],
    [{ enrolled: false, enrolledAt: null }, "Off"],
  ])("%j => %s", (mfa, text) => expect(mfaStatus({ mfa })).toBe(text));
});

describe("state", () => {
  it("users list: a Two-step verification column with On / Off", async () => {
    renderAt("/users");
    const table = await screen.findByRole("table", { name: "Users" });
    expect(within(table).getByRole("columnheader", { name: "Two-step verification" })).toBeTruthy();
    const [on, off] = within(table).getAllByRole("row").slice(1);
    expect(within(on!).getByText(`On (since ${SINCE})`)).toBeTruthy();
    expect(within(off!).getByText("Off")).toBeTruthy();
  });

  it("detail: the Two-step verification fact", async () => {
    await openDetail();
    const facts = within(screen.getByRole("region", { name: "Account" }));
    expect(facts.getByText("Two-step verification")).toBeTruthy();
    expect(facts.getByText(`On (since ${SINCE})`)).toBeTruthy();
  });
});

describe("Reset two-step verification: when offered", () => {
  it("enrolled + super admin: offered", async () => {
    await openDetail();
    expect(resetButton()).toBeTruthy();
  });

  it("enrolled + tenant_admin on a plain user: offered", async () => {
    vi.mocked(getViewer).mockResolvedValue(TENANT_ADMIN);
    await openDetail();
    expect(resetButton()).toBeTruthy();
  });

  it("not enrolled: not offered (the fact says Off)", async () => {
    user = OFF;
    await openDetail();
    expect(screen.getByText("Off")).toBeTruthy();
    expect(resetButton()).toBeNull();
  });

  it.each([["tenant_admin"], ["super_admin"]])("tenant_admin viewing a %s: not offered, explained", async (role) => {
    vi.mocked(getViewer).mockResolvedValue(TENANT_ADMIN);
    user = { ...ON, roles: [role] };
    await openDetail();
    expect(screen.getByText("Only a super admin can change this account.")).toBeTruthy();
    expect(resetButton()).toBeNull();
  });

  it("the dialog states the consequences; Cancel / Escape send nothing", async () => {
    await openDetail();
    fireEvent.click(resetButton()!);
    const text = (await dialog()).textContent!;
    expect(text).toContain("signed out everywhere");
    expect(text).toContain("set up two-step verification again");
    fireEvent.click(within(await dialog()).getByRole("button", { name: "Cancel" }));
    await noDialog();
    await waitFor(() => expect(document.activeElement).toBe(resetButton()));
    fireEvent.click(resetButton()!);
    await dialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await noDialog();
    expect(reset).not.toHaveBeenCalled();
  });

  it("self: the dialog warns that this console is signed out too", async () => {
    vi.mocked(getViewer).mockResolvedValue({ ...SUPER, sub: ID });
    await openDetail();
    fireEvent.click(resetButton()!);
    expect(within(await dialog()).getByRole("alert").textContent).toContain("This is your own account");
  });
});

describe("Reset two-step verification: outcomes", () => {
  it("double click => sent once; done => notice, focus on the heading, re-read shows Off and no button", async () => {
    reset.mockImplementation((async () => {
      user = OFF;
      return ok(undefined);
    }) as never);
    await openDetail();
    await confirmReset(2);
    await noDialog();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith({ data: ID });
    await waitFor(() =>
      expect(statusOf().textContent).toBe(
        "Two-step verification was reset. Every session of this account was ended; the user must set it up again.",
      ),
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Account" })));
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(resetButton()).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it("self + done: signInAgain (this console's session ended)", async () => {
    vi.mocked(getViewer).mockResolvedValue({ ...SUPER, sub: ID });
    reset.mockResolvedValue(ok(undefined) as never);
    vi.stubGlobal("location", { assign, pathname: `/users/${ID}`, search: "" });
    await openDetail();
    await confirmReset();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/auth/login?returnTo=${encodeURIComponent(`/users/${ID}`)}`));
  });

  it("step_up_required: StepUpAlert, nothing stored, not re-sent", async () => {
    reset.mockResolvedValue(fail("step_up_required") as never);
    await openDetail();
    const d = await confirmReset();
    const alert = await within(d).findByRole("alert");
    expect(alert.textContent).toContain("Confirm your identity to continue.");
    expect(sessionStorage.getItem("fea:stepup")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Confirm identity" }));
    expect(assign).toHaveBeenCalledWith(`/auth/login?stepup=1&returnTo=${encodeURIComponent(`/users/${ID}`)}`);
    await settle();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["uncertain (5xx)", () => fail("unavailable", true)],
    ["throw (network)", () => Promise.reject(new Error("network"))],
  ])("%s: dialog closed, reload-and-check message, data re-read, never re-sent", async (_, result) => {
    reset.mockImplementation((() => result()) as never);
    await openDetail();
    const reads = get.mock.calls.length;
    await confirmReset();
    await noDialog();
    await waitFor(() => expect(statusOf().textContent).toBe(MFA_RESET_UNCERTAIN));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(reads));
    await new Promise((r) => setTimeout(r, 200));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("self + uncertain: its own wording, never re-sent", async () => {
    vi.mocked(getViewer).mockResolvedValue({ ...SUPER, sub: ID });
    reset.mockResolvedValue(fail("unavailable", true) as never);
    await openDetail();
    await confirmReset();
    await noDialog();
    await waitFor(() => expect(statusOf().textContent).toBe(MFA_RESET_SELF_UNCERTAIN));
    expect(MFA_RESET_SELF_UNCERTAIN).not.toBe(MFA_RESET_UNCERTAIN);
    await settle();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("forbidden: fixed message in the dialog (BE text never shown), no re-read", async () => {
    reset.mockResolvedValue(fail("forbidden") as never);
    await openDetail();
    const reads = get.mock.calls.length;
    const d = await confirmReset();
    expect((await within(d).findByRole("alert")).textContent).toBe(
      "Only a super admin can change this account: it holds an admin role or belongs to another tenant.",
    );
    expect(document.body.textContent).not.toContain("msg forbidden");
    await settle();
    expect(get.mock.calls.length).toBe(reads);
  });

  it("not_found: fixed notice, writes hidden after the re-read", async () => {
    await openDetail();
    reset.mockResolvedValue(fail("not_found") as never);
    get.mockResolvedValue(fail("not_found") as never);
    await confirmReset();
    await noDialog();
    await waitFor(() => expect(statusOf().textContent).toBe("This user no longer exists in this tenant."));
    await screen.findByText("This user does not exist in your tenant.");
    expect(resetButton()).toBeNull();
  });

  it("nothing about the factor is stored in the browser", async () => {
    reset.mockResolvedValue(ok(undefined) as never);
    await openDetail();
    await confirmReset();
    await noDialog();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});
