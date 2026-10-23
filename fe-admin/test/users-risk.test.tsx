// Run 47 (A6.3) tester risk matrix (users UI): no one-click reversal after an uncertain write
// (Lock <-> Unlock), self revoke-all whose uncertain outcome was applied (401 => signInAgain), the
// email filter never reaching returnTo / storage / a reload, tenant_admin on own admin account,
// not_found on first load, lock sentinel vs near date, paging, DEBT-339 characterisation.
import type { QueryClient } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import {
  getUser,
  listUserConsents,
  listUserFamilies,
  listUsers,
  lockUser,
  revokeUserConsent,
  revokeUserFamily,
  revokeUserSessions,
  unlockUser,
} from "@/features/admin-api/users";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AdminApiErrorCode } from "@/features/admin-api/types";
import { LOCK_UNCERTAIN, UNLOCK_UNCERTAIN, lockStatus } from "@/features/users/user-account";
import type { AdminConsent, AdminFamily, AdminUser } from "@/server/admin-api/schemas";

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
}));

const mocks = {
  list: vi.mocked(listUsers),
  get: vi.mocked(getUser),
  families: vi.mocked(listUserFamilies),
  consents: vi.mocked(listUserConsents),
  lock: vi.mocked(lockUser),
  unlock: vi.mocked(unlockUser),
  revokeAll: vi.mocked(revokeUserSessions),
  revokeFamily: vi.mocked(revokeUserFamily),
  revokeConsent: vi.mocked(revokeUserConsent),
};

const ID = "0123456789abcdef01234567";
const EMAIL = "target.canary@example.com";
const USER: AdminUser = {
  id: ID,
  email: EMAIL,
  emailVerified: true,
  locked: false,
  lockedUntil: null,
  membershipStatus: "active",
  roles: [],
  createdAt: "2026-10-01T00:00:00.000Z",
};
const ADMIN_LOCK = "9999-12-31T23:59:59.999Z";
const FAMILY: AdminFamily = {
  familyId: "fam-1",
  clientId: "app-1",
  resource: "https://api.example.com/",
  scope: ["openid", "offline_access"],
  createdAt: "2026-10-01T00:00:00.000Z",
  lastRotatedAt: "2026-10-02T00:00:00.000Z",
  expiresAt: "2026-11-01T00:00:00.000Z",
  active: true,
  revokedAt: null,
};
const REVOKED: AdminFamily = { ...FAMILY, familyId: "fam-2", active: false, revokedAt: "2026-10-03T00:00:00.000Z" };
const CONSENT: AdminConsent = {
  id: "fedcba9876543210fedcba98",
  clientId: "app-1",
  resource: "https://api.example.com/",
  grantedScopes: ["openid"],
  policyVersion: null,
  termsVersion: null,
  grantedAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const SUPER = { sub: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "admin@example.com", roles: ["super_admin"], tenantId: "t1" };
const TENANT_ADMIN = { ...SUPER, roles: ["tenant_admin"] };
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: AdminApiErrorCode, uncertain = false) => ({
  ok: false as const,
  error: { code, message: `msg ${code}`, ...(uncertain ? { uncertain: true as const } : {}) },
});

let assign: ReturnType<typeof vi.fn>;
let user: AdminUser;

beforeEach(() => {
  sessionStorage.clear();
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue(SUPER);
  user = USER;
  mocks.list.mockResolvedValue(ok({ items: [USER], nextCursor: null }) as never);
  mocks.get.mockImplementation((async () => ok(user)) as never);
  mocks.families.mockResolvedValue(ok({ items: [FAMILY, REVOKED], nextCursor: null }) as never);
  mocks.consents.mockResolvedValue(ok({ items: [CONSENT], nextCursor: null }) as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderAt(path: string) {
  const queryClient = createQueryClient();
  lastClient = queryClient;
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
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const dialog = () => screen.findByRole("alertdialog");
const noDialog = () => waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
const section = (name: string) => screen.getByRole("region", { name });
const statusOf = (name: string) => within(section(name)).getByRole("status");
const openDetail = async () => {
  const router = renderAt(`/users/${ID}`);
  await screen.findByText(EMAIL);
  return router;
};
/** Open the dialog of `trigger` (in `scope`) and click its confirm button. */
async function confirmIn(trigger: HTMLElement, confirmLabel: string, clicks = 1) {
  fireEvent.click(trigger);
  const d = await dialog();
  const confirm = within(d).getByRole("button", { name: confirmLabel });
  for (let i = 0; i < clicks; i++) fireEvent.click(confirm);
  return d;
}
let lastClient: QueryClient | undefined;

describe("tester: uncertain writes have no one-click reversal (Lock <-> Unlock)", () => {
  it("lock uncertain but applied: dialog closed, re-read shows the lock, Unlock needs its own confirmation", async () => {
    await openDetail();
    mocks.lock.mockImplementation((async () => {
      user = { ...USER, locked: true, lockedUntil: ADMIN_LOCK };
      return fail("unavailable", true);
    }) as never);
    await confirmIn(button("Lock"), "Lock account", 3);
    await noDialog();
    await waitFor(() => expect(statusOf("Account").textContent).toBe(LOCK_UNCERTAIN));
    await screen.findByText("Locked by an administrator (until unlocked)");
    fireEvent.click(button("Unlock"));
    const d = await dialog();
    expect(within(d).getByRole("heading", { name: "Unlock this account?" })).toBeTruthy();
    await settle();
    expect(mocks.unlock).not.toHaveBeenCalled();
    expect(mocks.lock).toHaveBeenCalledTimes(1);
  });

  it("unlock uncertain but applied: re-read shows Not locked, Lock needs its own confirmation", async () => {
    user = { ...USER, locked: true, lockedUntil: ADMIN_LOCK };
    await openDetail();
    mocks.unlock.mockImplementation((async () => {
      user = USER;
      return fail("unavailable", true);
    }) as never);
    await confirmIn(button("Unlock"), "Unlock", 3);
    await noDialog();
    await screen.findByText("Not locked");
    expect(statusOf("Account").textContent).toBe(UNLOCK_UNCERTAIN);
    fireEvent.click(button("Lock"));
    expect(within(await dialog()).getByRole("button", { name: "Lock account" })).toBeTruthy();
    await settle();
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.unlock).toHaveBeenCalledTimes(1);
  });

  it("an open Lock dialog never turns into Unlock when a re-read flips the state", async () => {
    await openDetail();
    fireEvent.click(button("Lock"));
    await dialog();
    user = { ...USER, locked: true, lockedUntil: ADMIN_LOCK };
    await act(async () => {
      await lastClient!.invalidateQueries({ queryKey: ["admin", "users"] });
    });
    await screen.findByText("Locked by an administrator (until unlocked)");
    await noDialog();
    expect(screen.queryByRole("button", { name: "Lock account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlock" })).toBeTruthy();
    await settle();
    expect(mocks.unlock).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
  });

  it("lock thrown (network): dialog closed, uncertain message, sent once, nothing re-sent later", async () => {
    mocks.lock.mockRejectedValue(new Error("network"));
    await openDetail();
    await confirmIn(button("Lock"), "Lock account", 2);
    await noDialog();
    await waitFor(() => expect(statusOf("Account").textContent).toBe(LOCK_UNCERTAIN));
    await settle();
    await settle();
    expect(mocks.lock).toHaveBeenCalledTimes(1);
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("lock uncertain: Revoke all sessions stays available to finish the revoke", async () => {
    mocks.lock.mockImplementation((async () => {
      user = { ...USER, locked: true, lockedUntil: ADMIN_LOCK };
      return fail("unavailable", true);
    }) as never);
    await openDetail();
    await confirmIn(button("Lock"), "Lock account");
    await noDialog();
    await screen.findByText("Locked by an administrator (until unlocked)");
    expect(button("Revoke all sessions")).toBeTruthy();
  });
});

describe("tester: self revoke-all", () => {
  it("uncertain but applied: the re-read answers unauthenticated => signInAgain, returnTo without email", async () => {
    vi.mocked(getViewer).mockResolvedValue({ ...SUPER, sub: ID });
    vi.stubGlobal("location", { assign, pathname: `/users/${ID}`, search: "" });
    await openDetail();
    mocks.revokeAll.mockResolvedValue(fail("unavailable", true) as never);
    mocks.get.mockResolvedValue(fail("unauthenticated") as never);
    mocks.families.mockResolvedValue(fail("unauthenticated") as never);
    mocks.consents.mockResolvedValue(fail("unauthenticated") as never);
    await confirmIn(button("Revoke all sessions"), "Revoke all sessions");
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/auth/login?returnTo=${encodeURIComponent(`/users/${ID}`)}`));
    for (const [url] of assign.mock.calls) {
      expect(String(url)).not.toContain("canary");
      expect(String(url)).not.toContain(encodeURIComponent(EMAIL));
    }
    expect(mocks.revokeAll).toHaveBeenCalledTimes(1);
  });

  it("a tenant_admin on their own account (admin role): no Lock / Unlock / Revoke all (BE would 403)", async () => {
    vi.mocked(getViewer).mockResolvedValue({ ...TENANT_ADMIN, sub: ID });
    user = { ...USER, roles: ["tenant_admin"] };
    await openDetail();
    for (const name of ["Lock", "Unlock", "Revoke all sessions"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByText("Only a super admin can change this account.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke family of app-1" }));
    expect(within(await dialog()).getByRole("alert").textContent).toContain("own sign-in");
  });

  it("super_admin target seen by a super_admin: writes offered", async () => {
    user = { ...USER, roles: ["super_admin"] };
    await openDetail();
    expect(button("Lock")).toBeTruthy();
    expect(button("Revoke all sessions")).toBeTruthy();
  });
});

describe("tester: the email filter never leaves the page state", () => {
  it("list unauthenticated after filtering: returnTo has only the path + status, no email; nothing stored", async () => {
    vi.stubGlobal("location", { assign, pathname: "/users", search: "?status=active" });
    renderAt("/users?status=active");
    await screen.findByRole("table", { name: "Users" });
    mocks.list.mockResolvedValue(fail("unauthenticated") as never);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: EMAIL } });
    fireEvent.click(button("Filter"));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign).toHaveBeenCalledWith(`/auth/login?returnTo=${encodeURIComponent("/users?status=active")}`);
    const all = JSON.stringify([assign.mock.calls, { ...sessionStorage }, { ...localStorage }, document.cookie]);
    expect(all).not.toContain("canary");
    expect(all).not.toContain(encodeURIComponent(EMAIL));
    expect(mocks.list).toHaveBeenLastCalledWith({ data: { limit: 20, status: "active", email: EMAIL } });
  });

  it("list error (5xx) after filtering: the alert and the URL do not echo the email", async () => {
    const router = renderAt("/users");
    await screen.findByRole("table", { name: "Users" });
    mocks.list.mockResolvedValue(fail("unavailable") as never);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: EMAIL } });
    fireEvent.click(button("Filter"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("canary");
    expect(router.state.location.href).not.toContain("canary");
  });

  it("a reload (fresh mount on the same URL) starts without the email filter", async () => {
    const router = renderAt("/users");
    await screen.findByRole("table", { name: "Users" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: EMAIL } });
    fireEvent.click(button("Filter"));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ data: { limit: 20, email: EMAIL } }));
    const href = router.state.location.href;
    cleanup();
    mocks.list.mockClear();
    renderAt(href);
    await screen.findByRole("table", { name: "Users" });
    expect(mocks.list).toHaveBeenCalledWith({ data: { limit: 20 } });
    expect(JSON.stringify(mocks.list.mock.calls)).not.toContain("canary");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("");
  });

  it("opening a user from a filtered list, then step-up: URL and returnTo carry the id only", async () => {
    const router = renderAt("/users");
    await screen.findByRole("table", { name: "Users" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: EMAIL } });
    fireEvent.click(button("Filter"));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ data: { limit: 20, email: EMAIL } }));
    fireEvent.click(await screen.findByRole("link", { name: EMAIL }));
    await screen.findByRole("heading", { name: "Account" });
    expect(router.state.location.href).toBe(`/users/${ID}`);
    mocks.lock.mockResolvedValue(fail("step_up_required") as never);
    const d = await confirmIn(button("Lock"), "Lock account");
    fireEvent.click(await within(d).findByRole("button", { name: "Confirm identity" }));
    expect(assign).toHaveBeenCalledWith(`/auth/login?stepup=1&returnTo=${encodeURIComponent(`/users/${ID}`)}`);
    expect(sessionStorage.length).toBe(0);
  });
});

describe("tester: detail edge states", () => {
  it("not_found on the first load: no write control, families / consents never read", async () => {
    mocks.get.mockResolvedValue(fail("not_found") as never);
    renderAt(`/users/${ID}`);
    await screen.findByText("This user does not exist in your tenant.");
    await settle();
    for (const name of [/^Lock$/, /^Unlock$/, /Revoke/]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(mocks.families).not.toHaveBeenCalled();
    expect(mocks.consents).not.toHaveBeenCalled();
  });

  it.each([
    ["9999-01-01T00:00:00.000Z", "Locked by an administrator (until unlocked)"],
    ["2026-10-23T10:15:00.000Z", "Temporarily locked after failed sign-ins until 2026-10-23T10:15:00.000Z"],
    ["2099-12-31T23:59:59.999Z", "Temporarily locked after failed sign-ins until 2099-12-31T23:59:59.999Z"],
  ])("locked until %s => %s (ISO text verbatim)", async (lockedUntil, text) => {
    user = { ...USER, locked: true, lockedUntil };
    await openDetail();
    expect(screen.getByText(text)).toBeTruthy();
    expect(button("Unlock")).toBeTruthy();
  });

  it("locked with lockedUntil null (characterisation): shown as an administrator lock", () => {
    expect(lockStatus({ locked: true, lockedUntil: null })).toBe("Locked by an administrator (until unlocked)");
  });

  it("a viewer without the exact super_admin role gets no write on an admin target", async () => {
    vi.mocked(getViewer).mockResolvedValue({ ...SUPER, roles: ["tenant_admin", "SUPER_ADMIN"] });
    user = { ...USER, roles: ["tenant_admin"] };
    await openDetail();
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();
  });
});

describe("tester: paging", () => {
  it("consents: next page in local state (URL unchanged), First page goes back", async () => {
    mocks.consents.mockResolvedValue(ok({ items: [CONSENT], nextCursor: "e".repeat(24) }) as never);
    const router = await openDetail();
    const consents = await waitFor(() => section("Consents"));
    fireEvent.click(await within(consents).findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(mocks.consents).toHaveBeenLastCalledWith({ data: { userId: ID, limit: 20, after: "e".repeat(24) } }));
    expect(router.state.location.href).toBe(`/users/${ID}`);
    fireEvent.click(await within(section("Consents")).findByRole("button", { name: "First page" }));
    await waitFor(() => expect(mocks.consents).toHaveBeenLastCalledWith({ data: { userId: ID, limit: 20 } }));
  });

  it("families: an empty next page says so and offers First page", async () => {
    mocks.families.mockImplementation((async ({ data }: { data: { after?: string } }) =>
      ok(data.after ? { items: [], nextCursor: null } : { items: [FAMILY], nextCursor: "fam-9" })) as never);
    await openDetail();
    fireEvent.click(await within(await waitFor(() => section("Refresh token families"))).findByRole("button", { name: "Next page" }));
    await screen.findByText("No more families.");
    expect(within(section("Refresh token families")).getByRole("button", { name: "First page" })).toBeTruthy();
  });
});

describe("tester: DEBT-339 characterisation", () => {
  it("family uncertain but applied: the row (and its dialog) is gone after the re-read; no re-send", async () => {
    await openDetail();
    mocks.revokeFamily.mockImplementation((async () => {
      mocks.families.mockResolvedValue(ok({ items: [{ ...FAMILY, active: false, revokedAt: "2026-10-23T00:00:00.000Z" }], nextCursor: null }) as never);
      return fail("unavailable", true);
    }) as never);
    await confirmIn(await screen.findByRole("button", { name: "Revoke family of app-1" }), "Revoke family");
    await screen.findByText("Revoked 2026-10-23T00:00:00.000Z");
    await noDialog();
    // DEBT-339: the uncertain message lived in the unmounted dialog; the status region stays empty
    expect(statusOf("Refresh token families").textContent).toBe("");
    expect(mocks.revokeFamily).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Revoke family of app-1" })).toBeNull();
  });
});
