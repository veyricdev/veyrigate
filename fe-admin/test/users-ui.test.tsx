// Run 47 (A6.3) users UI through the real route tree under StrictMode (server fns mocked), rendered
// into `document` (DEBT-312: the pages open Radix AlertDialogs). List (email filter never in the URL),
// detail (lock states as ISO text, invalid id never sent, UX gates), lock/unlock, revoke all,
// families, consents: confirmation, step-up without intent, uncertain never re-sent, not_found.
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
import { LOCK_UNCERTAIN, REVOKE_ALL_UNCERTAIN, UNLOCK_UNCERTAIN, lockStatus } from "@/features/users/user-account";
import { CONSENT_UNCERTAIN, FAMILY_UNCERTAIN } from "@/features/users/user-grants";
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
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
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

describe("lockStatus (ISO text, no locale)", () => {
  it.each([
    [{ locked: true, lockedUntil: ADMIN_LOCK }, "Locked by an administrator (until unlocked)"],
    [{ locked: true, lockedUntil: "2026-10-23T10:15:00.000Z" }, "Temporarily locked after failed sign-ins until 2026-10-23T10:15:00.000Z"],
    [{ locked: false, lockedUntil: "2026-10-20T10:15:00.000Z" }, "Not locked"],
    [{ locked: false, lockedUntil: null }, "Not locked"],
  ])("%j => %s", (u, text) => expect(lockStatus(u)).toBe(text));
});

describe("users list", () => {
  it("semantic table; the email is text inside a link by id; nav entry", async () => {
    mocks.list.mockResolvedValue(ok({ items: [{ ...USER, locked: true, lockedUntil: ADMIN_LOCK, roles: ["tenant_admin"] }], nextCursor: null }) as never);
    renderAt("/users");
    const table = await screen.findByRole("table", { name: "Users" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Email", "Lock", "Membership", "Roles", "Created"]);
    expect(within(table).getByRole("link", { name: EMAIL }).getAttribute("href")).toBe(`/users/${ID}`);
    expect(within(table).getByText("Locked by an administrator (until unlocked)")).toBeTruthy();
    expect(within(table).getByText("tenant_admin")).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith({ data: { limit: 20 } });
    expect(screen.getByRole("navigation", { name: "Main" }).querySelector('a[href="/users"]')).not.toBeNull();
  });

  it("email filter: sent in the server fn body only, never in the URL / search / history", async () => {
    const router = renderAt("/users?after=" + "c".repeat(24));
    await screen.findByRole("table", { name: "Users (next page)" });
    const input = screen.getByLabelText("Email") as HTMLInputElement;
    expect(input.getAttribute("name")).toBeNull();
    fireEvent.change(input, { target: { value: `  ${EMAIL} ` } });
    fireEvent.click(button("Filter"));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ data: { limit: 20, email: EMAIL } }));
    await settle();
    expect(router.state.location.href).not.toContain("canary");
    expect(router.state.location.search).toEqual({});
    expect(router.history.location.href).not.toContain("canary");
  });

  it("status filter goes to the search params (first page); Clear drops both filters", async () => {
    const router = renderAt("/users");
    await screen.findByRole("table", { name: "Users" });
    fireEvent.change(screen.getByLabelText("Membership status"), { target: { value: "suspended" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: EMAIL } });
    fireEvent.click(button("Filter"));
    await waitFor(() => expect(router.state.location.search).toEqual({ status: "suspended" }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ data: { limit: 20, status: "suspended", email: EMAIL } }));
    fireEvent.click(button("Clear"));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ data: { limit: 20 } }));
  });

  it("no match for an email: fixed text (no oracle beyond the tenant)", async () => {
    renderAt("/users");
    await screen.findByRole("table", { name: "Users" });
    mocks.list.mockResolvedValue(ok({ items: [], nextCursor: null }) as never);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "nobody@example.com" } });
    fireEvent.click(button("Filter"));
    expect(await screen.findByText("No user with this email in this tenant.")).toBeTruthy();
  });

  it("next page keeps the status and uses ?after=<nextCursor>; a bad cursor in the URL is dropped", async () => {
    mocks.list.mockResolvedValue(ok({ items: [USER], nextCursor: "d".repeat(24) }) as never);
    const router = renderAt("/users?status=active&after=nothex");
    await screen.findByRole("table", { name: "Users" });
    expect(mocks.list).toHaveBeenCalledWith({ data: { limit: 20, status: "active" } });
    fireEvent.click(screen.getByRole("link", { name: "Next page" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ status: "active", after: "d".repeat(24) }));
  });

  it("error state: alert + retry", async () => {
    mocks.list.mockResolvedValue(fail("unavailable") as never);
    renderAt("/users");
    expect((await screen.findByRole("alert")).textContent).toContain("msg unavailable");
  });
});

describe("user detail", () => {
  it.each(["abc", "0123456789abcdef0123456", "0123456789abcdef012345678", "0123456789abcdef0123456g"])(
    "id %s is not 24 hex: not found, getUser never called",
    async (id) => {
      renderAt(`/users/${id}`);
      expect(await screen.findByText("This user does not exist in your tenant.")).toBeTruthy();
      await settle();
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.families).not.toHaveBeenCalled();
    },
  );

  it("facts as text, lock state, families + consents tables; revoke only on active families", async () => {
    user = { ...USER, locked: true, lockedUntil: "2026-10-23T10:15:00.000Z" };
    await openDetail();
    expect(screen.getByText("Temporarily locked after failed sign-ins until 2026-10-23T10:15:00.000Z")).toBeTruthy();
    const families = await screen.findByRole("table", { name: "Refresh token families" });
    const rows = within(families).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByRole("button", { name: "Revoke family of app-1" })).toBeTruthy();
    expect(within(rows[1]!).queryByRole("button")).toBeNull();
    expect(within(rows[1]!).getByText("Revoked 2026-10-03T00:00:00.000Z")).toBeTruthy();
    expect(await screen.findByRole("table", { name: "Consents" })).toBeTruthy();
    expect(document.querySelectorAll("a[href^='http'], a[href^='javascript']")).toHaveLength(0);
    expect(mocks.families).toHaveBeenCalledWith({ data: { userId: ID, limit: 20 } });
  });

  it("admin lock: sentinel year 9999 shown as an administrator lock; Unlock instead of Lock", async () => {
    user = { ...USER, locked: true, lockedUntil: ADMIN_LOCK };
    await openDetail();
    expect(screen.getByText("Locked by an administrator (until unlocked)")).toBeTruthy();
    expect(button("Unlock")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();
  });

  it("past lockedUntil: Not locked + Lock", async () => {
    user = { ...USER, locked: false, lockedUntil: "2020-01-01T00:00:00.000Z" };
    await openDetail();
    expect(screen.getByText("Not locked")).toBeTruthy();
    expect(button("Lock")).toBeTruthy();
  });

  it("self (case-insensitive): no Lock; Revoke all and family dialogs carry an alert", async () => {
    vi.mocked(getViewer).mockResolvedValue({ ...SUPER, sub: ID.toUpperCase() });
    await openDetail();
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();
    expect(screen.getByText("You cannot lock your own account.")).toBeTruthy();
    fireEvent.click(button("Revoke all sessions"));
    expect(within(await dialog()).getByRole("alert").textContent).toContain("This is your own account");
    escape();
    await noDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke family of app-1" }));
    expect(within(await dialog()).getByRole("alert").textContent).toContain("this console's own sign-in");
  });

  it("not self: no self warnings", async () => {
    await openDetail();
    fireEvent.click(button("Revoke all sessions"));
    expect(within(await dialog()).queryByRole("alert")).toBeNull();
  });

  it.each([["tenant_admin"], ["super_admin"]])("tenant_admin viewing a %s: no lock/unlock/revoke-all", async (role) => {
    vi.mocked(getViewer).mockResolvedValue(TENANT_ADMIN);
    user = { ...USER, roles: [role] };
    await openDetail();
    expect(screen.getByText("Only a super admin can change this account.")).toBeTruthy();
    for (const name of ["Lock", "Unlock", "Revoke all sessions"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("tenant_admin viewing a plain user: Lock and Revoke all offered", async () => {
    vi.mocked(getViewer).mockResolvedValue(TENANT_ADMIN);
    await openDetail();
    expect(button("Lock")).toBeTruthy();
    expect(button("Revoke all sessions")).toBeTruthy();
  });

  it("the dialogs say the effect is global (every tenant)", async () => {
    await openDetail();
    fireEvent.click(button("Lock"));
    expect((await dialog()).textContent).toContain("every tenant");
    escape();
    await noDialog();
    fireEvent.click(button("Revoke all sessions"));
    expect((await dialog()).textContent).toContain("every tenant, not only this one");
  });
});

describe("lock / unlock", () => {
  it("double click on confirm => lock sent once; done => notice, focus on the heading, data re-read", async () => {
    mocks.lock.mockImplementation((async () => {
      user = { ...USER, locked: true, lockedUntil: ADMIN_LOCK };
      return ok(user);
    }) as never);
    await openDetail();
    const reads = mocks.get.mock.calls.length;
    await confirmIn(button("Lock"), "Lock account", 2);
    await noDialog();
    expect(mocks.lock).toHaveBeenCalledTimes(1);
    expect(mocks.lock).toHaveBeenCalledWith({ data: ID });
    await waitFor(() => expect(statusOf("Account").textContent).toBe("Account locked. Every session and refresh token was ended."));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Account" })));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(reads));
    expect(await screen.findByText("Locked by an administrator (until unlocked)")).toBeTruthy();
    expect(mocks.families.mock.calls.length).toBeGreaterThan(1); // users.all invalidated
  });

  it("Cancel / Escape => nothing sent", async () => {
    await openDetail();
    fireEvent.click(button("Lock"));
    fireEvent.click(within(await dialog()).getByRole("button", { name: "Cancel" }));
    await noDialog();
    fireEvent.click(button("Lock"));
    await dialog();
    escape();
    await noDialog();
    expect(mocks.lock).not.toHaveBeenCalled();
  });

  it("step_up_required: StepUpAlert without the Settings note, no stored intent, not re-sent", async () => {
    mocks.lock.mockResolvedValue(fail("step_up_required") as never);
    await openDetail();
    const d = await confirmIn(button("Lock"), "Lock account");
    const alert = await within(d).findByRole("alert");
    expect(alert.textContent).toContain("Confirm your identity to continue.");
    expect(alert.textContent).not.toContain("Unsaved changes");
    expect(sessionStorage.getItem("fea:stepup")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Confirm identity" }));
    expect(assign).toHaveBeenCalledWith(`/auth/login?stepup=1&returnTo=${encodeURIComponent(`/users/${ID}`)}`);
    await settle();
    expect(mocks.lock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["uncertain", () => fail("unavailable", true)],
    ["throw", () => Promise.reject(new Error("network"))],
  ])("lock %s: dialog closed, message points to Revoke all sessions, re-read, sent once", async (_, result) => {
    mocks.lock.mockImplementation((() => result()) as never);
    await openDetail();
    const reads = mocks.get.mock.calls.length;
    await confirmIn(button("Lock"), "Lock account");
    await noDialog();
    await waitFor(() => expect(statusOf("Account").textContent).toBe(LOCK_UNCERTAIN));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(reads));
    await settle();
    expect(mocks.lock).toHaveBeenCalledTimes(1);
    expect(button("Revoke all sessions")).toBeTruthy();
  });

  it("lock forbidden: fixed message in the dialog, no re-read", async () => {
    mocks.lock.mockResolvedValue(fail("forbidden") as never);
    await openDetail();
    const reads = mocks.get.mock.calls.length;
    const d = await confirmIn(button("Lock"), "Lock account");
    expect((await within(d).findByRole("alert")).textContent).toBe(
      "Only a super admin can change this account: it holds an admin role or belongs to another tenant.",
    );
    await settle();
    expect(mocks.get.mock.calls.length).toBe(reads);
  });

  it("unlock uncertain: dialog closed, check-before-retry message, sent once", async () => {
    user = { ...USER, locked: true, lockedUntil: ADMIN_LOCK };
    mocks.unlock.mockResolvedValue(fail("unavailable", true) as never);
    await openDetail();
    await confirmIn(button("Unlock"), "Unlock");
    await noDialog();
    await waitFor(() => expect(statusOf("Account").textContent).toBe(UNLOCK_UNCERTAIN));
    expect(mocks.unlock).toHaveBeenCalledTimes(1);
  });

  it("not_found on a re-read (DEBT-320): every write is hidden, the facts stay", async () => {
    await openDetail();
    mocks.lock.mockResolvedValue(fail("not_found") as never);
    mocks.get.mockResolvedValue(fail("not_found") as never);
    await confirmIn(button("Lock"), "Lock account");
    await noDialog();
    await waitFor(() => expect(statusOf("Account").textContent).toBe("This user no longer exists in this tenant."));
    await screen.findByText("This user does not exist in your tenant.");
    expect(screen.getByText(EMAIL)).toBeTruthy();
    for (const name of [/^Lock$/, /^Unlock$/, /Revoke/]) expect(screen.queryByRole("button", { name })).toBeNull();
  });
});

describe("revoke all sessions", () => {
  it("done: notice + invalidation", async () => {
    mocks.revokeAll.mockResolvedValue(ok(undefined) as never);
    await openDetail();
    const reads = mocks.families.mock.calls.length;
    await confirmIn(button("Revoke all sessions"), "Revoke all sessions");
    await noDialog();
    await waitFor(() => expect(statusOf("Account").textContent).toBe("Every session and refresh token of this account was ended."));
    await waitFor(() => expect(mocks.families.mock.calls.length).toBeGreaterThan(reads));
    expect(assign).not.toHaveBeenCalled();
  });

  it("self + done: signInAgain (login with returnTo = this page), no notice", async () => {
    vi.mocked(getViewer).mockResolvedValue({ ...SUPER, sub: ID });
    mocks.revokeAll.mockResolvedValue(ok(undefined) as never);
    // `signInAgain` reads the browser location (the memory history does not move it).
    vi.stubGlobal("location", { assign, pathname: `/users/${ID}`, search: "" });
    await openDetail();
    await confirmIn(button("Revoke all sessions"), "Revoke all sessions");
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/auth/login?returnTo=${encodeURIComponent(`/users/${ID}`)}`));
    expect(statusOf("Account").textContent).toBe("");
  });

  it("uncertain: stays in the dialog (idempotent: again is safe), each click sends once", async () => {
    mocks.revokeAll.mockResolvedValue(fail("unavailable", true) as never);
    await openDetail();
    const d = await confirmIn(button("Revoke all sessions"), "Revoke all sessions");
    expect((await within(d).findByRole("alert")).textContent).toBe(REVOKE_ALL_UNCERTAIN);
    expect(mocks.revokeAll).toHaveBeenCalledTimes(1);
    fireEvent.click(within(d).getByRole("button", { name: "Revoke all sessions" }));
    await waitFor(() => expect(mocks.revokeAll).toHaveBeenCalledTimes(2));
  });

  it("step_up_required: StepUpAlert, no intent", async () => {
    mocks.revokeAll.mockResolvedValue(fail("step_up_required") as never);
    await openDetail();
    const d = await confirmIn(button("Revoke all sessions"), "Revoke all sessions");
    expect((await within(d).findByRole("alert")).textContent).toContain("Confirm your identity");
    expect(sessionStorage.getItem("fea:stepup")).toBeNull();
  });
});

describe("families", () => {
  const revokeTrigger = () => screen.findByRole("button", { name: "Revoke family of app-1" });

  it("done: sent once with ids, notice + heading focus + re-read", async () => {
    mocks.revokeFamily.mockResolvedValue(ok(undefined) as never);
    await openDetail();
    const reads = mocks.families.mock.calls.length;
    const d = await confirmIn(await revokeTrigger(), "Revoke family", 2);
    expect(d.textContent).toContain("Access tokens already issued stay valid until they expire.");
    await noDialog();
    expect(mocks.revokeFamily).toHaveBeenCalledTimes(1);
    expect(mocks.revokeFamily).toHaveBeenCalledWith({ data: { userId: ID, familyId: "fam-1" } });
    await waitFor(() => expect(statusOf("Refresh token families").textContent).toBe("Refresh token family revoked."));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Refresh token families" })));
    await waitFor(() => expect(mocks.families.mock.calls.length).toBeGreaterThan(reads));
  });

  it("uncertain: stays, safe-again message, re-read, one send per click", async () => {
    mocks.revokeFamily.mockResolvedValue(fail("unavailable", true) as never);
    await openDetail();
    const reads = mocks.families.mock.calls.length;
    const d = await confirmIn(await revokeTrigger(), "Revoke family");
    expect((await within(d).findByRole("alert")).textContent).toBe(FAMILY_UNCERTAIN);
    await waitFor(() => expect(mocks.families.mock.calls.length).toBeGreaterThan(reads));
    expect(mocks.revokeFamily).toHaveBeenCalledTimes(1);
  });

  it("404: not visible message + re-read", async () => {
    mocks.revokeFamily.mockResolvedValue(fail("not_found") as never);
    await openDetail();
    const reads = mocks.families.mock.calls.length;
    await confirmIn(await revokeTrigger(), "Revoke family");
    await noDialog();
    await waitFor(() => expect(statusOf("Refresh token families").textContent).toBe("This family is not visible in this tenant."));
    await waitFor(() => expect(mocks.families.mock.calls.length).toBeGreaterThan(reads));
  });

  it("step_up_required: StepUpAlert, no intent", async () => {
    mocks.revokeFamily.mockResolvedValue(fail("step_up_required") as never);
    await openDetail();
    const d = await confirmIn(await revokeTrigger(), "Revoke family");
    expect((await within(d).findByRole("alert")).textContent).toContain("Confirm your identity");
    expect(sessionStorage.getItem("fea:stepup")).toBeNull();
  });

  it("pages kept in local state, not in the URL", async () => {
    mocks.families.mockResolvedValue(ok({ items: [FAMILY], nextCursor: "fam-9" }) as never);
    const router = await openDetail();
    fireEvent.click(await within(await waitFor(() => section("Refresh token families"))).findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(mocks.families).toHaveBeenLastCalledWith({ data: { userId: ID, limit: 20, after: "fam-9" } }));
    expect(router.state.location.href).toBe(`/users/${ID}`);
  });
});

describe("consents", () => {
  const revokeTrigger = () => screen.findByRole("button", { name: "Revoke consent for app-1" });

  it("done: notice + re-read", async () => {
    mocks.revokeConsent.mockResolvedValue(ok(undefined) as never);
    await openDetail();
    await confirmIn(await revokeTrigger(), "Revoke consent");
    await noDialog();
    expect(mocks.revokeConsent).toHaveBeenCalledWith({ data: { userId: ID, consentId: CONSENT.id } });
    await waitFor(() => expect(statusOf("Consents").textContent).toBe("Consent revoked."));
  });

  it("404: already revoked + re-read", async () => {
    mocks.revokeConsent.mockResolvedValue(fail("not_found") as never);
    await openDetail();
    const reads = mocks.consents.mock.calls.length;
    await confirmIn(await revokeTrigger(), "Revoke consent");
    await noDialog();
    await waitFor(() => expect(statusOf("Consents").textContent).toBe("This consent was already revoked."));
    await waitFor(() => expect(mocks.consents.mock.calls.length).toBeGreaterThan(reads));
  });

  it.each([
    ["uncertain", () => fail("unavailable", true)],
    ["throw", () => Promise.reject(new Error("network"))],
  ])("%s: dialog closed (not idempotent), DEBT-151 message, re-read, sent once", async (_, result) => {
    mocks.revokeConsent.mockImplementation((() => result()) as never);
    await openDetail();
    const reads = mocks.consents.mock.calls.length;
    await confirmIn(await revokeTrigger(), "Revoke consent", 2);
    await noDialog();
    await waitFor(() => expect(statusOf("Consents").textContent).toBe(CONSENT_UNCERTAIN));
    await waitFor(() => expect(mocks.consents.mock.calls.length).toBeGreaterThan(reads));
    await settle();
    expect(mocks.revokeConsent).toHaveBeenCalledTimes(1);
  });

  it("step_up_required: StepUpAlert, no intent", async () => {
    mocks.revokeConsent.mockResolvedValue(fail("step_up_required") as never);
    await openDetail();
    const d = await confirmIn(await revokeTrigger(), "Revoke consent");
    expect((await within(d).findByRole("alert")).textContent).toContain("Confirm your identity");
    expect(sessionStorage.getItem("fea:stepup")).toBeNull();
  });
});
