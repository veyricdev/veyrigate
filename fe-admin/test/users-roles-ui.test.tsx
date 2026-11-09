// Run 70 (A6.3b) admin roles of a user through the real route tree under StrictMode (server fns
// mocked), rendered into `document` (DEBT-312). UX gates (self, super_admin only for a super admin,
// a tenant_admin may change another tenant_admin), body = full admin set (other roles never sent),
// fixed messages (no BE description in the DOM), uncertain never re-sent, step-up without intent, a11y.
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { getUser, listUserConsents, listUserFamilies, setUserRoles } from "@/features/admin-api/users";
import { createQueryClient } from "@/features/admin-api/query-client";
import type { AdminApiErrorCode } from "@/features/admin-api/types";
import { ROLES_DONE, ROLES_UNCERTAIN } from "@/features/users/user-roles";
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
  setUserRoles: vi.fn(),
}));

const setRoles = vi.mocked(setUserRoles);
const ID = "0123456789abcdef01234567";
const EMAIL = "target@example.com";
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
const SUPER = { sub: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "admin@example.com", roles: ["super_admin"], tenantId: "t1" };
const TENANT_ADMIN = { ...SUPER, roles: ["tenant_admin"] };
const DESC = "secret-desc-xyz";
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: AdminApiErrorCode, uncertain = false) => ({
  ok: false as const,
  error: { code, message: DESC, ...(uncertain ? { uncertain: true as const } : {}) },
});

let user: AdminUser;

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
  vi.mocked(getUiPrefs).mockResolvedValue({ theme: "light", sidebarOpen: true });
  vi.mocked(getViewer).mockResolvedValue(SUPER);
  user = USER;
  vi.mocked(getUser).mockImplementation((async () => ok(user)) as never);
  vi.mocked(listUserFamilies).mockResolvedValue(ok({ items: [], nextCursor: null }) as never);
  vi.mocked(listUserConsents).mockResolvedValue(ok({ items: [], nextCursor: null }) as never);
  setRoles.mockImplementation((async ({ data }: { data: { roles: string[] } }) => {
    user = { ...user, roles: [...user.roles.filter((r) => r !== "tenant_admin" && r !== "super_admin"), ...data.roles] };
    return ok(user);
  }) as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function openDetail() {
  const queryClient = createQueryClient();
  queryClient.setQueryDefaults(["admin"], { retry: false });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/users/${ID}`] }),
    Wrap: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
    { container: document as never }, // DEBT-312
  );
  await screen.findByText(EMAIL);
}

const roles = () => screen.getByRole("region", { name: "Admin roles" });
const box = (name: RegExp) => within(roles()).getByRole("checkbox", { name });
const saveButton = () => within(roles()).queryByRole("button", { name: "Save roles" });
const noDialog = () => waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
async function save() {
  fireEvent.click(saveButton()!);
  const d = await screen.findByRole("alertdialog");
  fireEvent.click(within(d).getByRole("button", { name: "Change roles" }));
  return d;
}

describe("viewer super_admin", () => {
  it("both checkboxes; grant tenant_admin => body {roles:[tenant_admin]}; notice + focus on the heading; draft reset", async () => {
    await openDetail();
    expect(within(roles()).getAllByRole("checkbox")).toHaveLength(2);
    expect(saveButton()).toBeNull();
    fireEvent.click(box(/^tenant admin$/i));
    const d = await save();
    expect(d.textContent).toContain("Grant: Tenant admin");
    expect(within(d).queryByRole("alert")).toBeNull();
    await noDialog();
    expect(setRoles).toHaveBeenCalledTimes(1);
    expect(setRoles).toHaveBeenCalledWith({ data: { userId: ID, roles: ["tenant_admin"] } });
    await waitFor(() => expect(within(roles()).getByRole("status").textContent).toBe(ROLES_DONE));
    await waitFor(() => expect(document.activeElement?.id).toBe("roles-title"));
    await waitFor(() => expect((box(/^tenant admin$/i) as HTMLInputElement).checked).toBe(true));
    expect(saveButton()).toBeNull();
  });

  it("grant super_admin: destructive dialog with an alert; order fixed", async () => {
    user = { ...USER, roles: ["tenant_admin"] };
    await openDetail();
    fireEvent.click(box(/^super admin$/i));
    fireEvent.click(saveButton()!);
    const d = await screen.findByRole("alertdialog");
    expect(within(d).getByRole("alert").textContent).toBe("Super admin can manage every tenant, every resource and the signing keys.");
    fireEvent.click(within(d).getByRole("button", { name: "Change roles" }));
    await noDialog();
    expect(setRoles).toHaveBeenCalledWith({ data: { userId: ID, roles: ["tenant_admin", "super_admin"] } });
  });

  it("remove every admin role => body {roles:[]}; removing super_admin says one must remain", async () => {
    user = { ...USER, roles: ["super_admin", "tenant_admin"] };
    await openDetail();
    fireEvent.click(box(/^tenant admin$/i));
    fireEvent.click(box(/^super admin$/i));
    const d = await save();
    expect(d.textContent).toContain("Remove: Tenant admin, Super admin");
    expect(d.textContent).toContain("The tenant must keep at least one active super admin.");
    await noDialog();
    expect(setRoles).toHaveBeenCalledWith({ data: { userId: ID, roles: [] } });
  });

  it("ticking back to the server value: no Save button", async () => {
    await openDetail();
    fireEvent.click(box(/^tenant admin$/i));
    expect(saveButton()).not.toBeNull();
    fireEvent.click(box(/^tenant admin$/i));
    expect(saveButton()).toBeNull();
  });
});

describe("viewer tenant_admin", () => {
  beforeEach(() => vi.mocked(getViewer).mockResolvedValue(TENANT_ADMIN));

  it("no Super admin checkbox at all (not even disabled)", async () => {
    await openDetail();
    expect(within(roles()).queryByRole("checkbox", { name: /super admin/i })).toBeNull();
    expect(within(roles()).getAllByRole("checkbox")).toHaveLength(1);
  });

  it("target holds super_admin: no form, fixed text", async () => {
    user = { ...USER, roles: ["super_admin"] };
    await openDetail();
    expect(within(roles()).queryByRole("checkbox")).toBeNull();
    expect(within(roles()).getByText("Only a super admin can change the roles of a super admin.")).toBeTruthy();
  });

  it("target is another tenant_admin: the form IS offered (not the lock gate)", async () => {
    user = { ...USER, roles: ["tenant_admin"] };
    await openDetail();
    expect((box(/^tenant admin$/i) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Only a super admin can change this account.")).toBeTruthy(); // lock gate unchanged
  });

  it("target [auditor, tenant_admin], remove tenant_admin => body {roles:[]} (no auditor)", async () => {
    user = { ...USER, roles: ["auditor", "tenant_admin"] };
    await openDetail();
    fireEvent.click(box(/^tenant admin$/i));
    await save();
    await noDialog();
    expect(setRoles).toHaveBeenCalledWith({ data: { userId: ID, roles: [] } });
  });
});

describe("gates", () => {
  it("self (case-insensitive): no form, fixed text", async () => {
    vi.mocked(getViewer).mockResolvedValue({ ...SUPER, sub: ID.toUpperCase() });
    await openDetail();
    expect(within(roles()).queryByRole("checkbox")).toBeNull();
    expect(within(roles()).getByText("You cannot change your own roles.")).toBeTruthy();
  });
});

describe("outcomes", () => {
  it.each([
    ["forbidden", "You cannot make this change: only a super admin can grant or remove super admin or change a super admin, and nobody can change their own roles."],
    ["conflict", "Not changed: the tenant must keep at least one active super admin."],
    ["invalid_request", "The roles were rejected. Reload the page and try again."],
  ] as const)("%s => fixed message in the dialog, the BE description never in the DOM", async (code, text) => {
    setRoles.mockResolvedValue(fail(code) as never);
    await openDetail();
    fireEvent.click(box(/^tenant admin$/i));
    const d = await save();
    expect((await within(d).findByRole("alert")).textContent).toBe(text);
    expect(document.body.textContent).not.toContain(DESC);
  });

  it("5xx (uncertain) => dialog closes, ROLES_UNCERTAIN, sent once", async () => {
    setRoles.mockResolvedValue(fail("unavailable", true) as never);
    await openDetail();
    fireEvent.click(box(/^tenant admin$/i));
    await save();
    await noDialog();
    await waitFor(() => expect(within(roles()).getByRole("status").textContent).toBe(ROLES_UNCERTAIN));
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(setRoles).toHaveBeenCalledTimes(1);
  });

  it("not_found => dialog closes with the fixed text", async () => {
    setRoles.mockResolvedValue(fail("not_found") as never);
    await openDetail();
    fireEvent.click(box(/^tenant admin$/i));
    await save();
    await noDialog();
    await waitFor(() => expect(within(roles()).getByRole("status").textContent).toBe("This user no longer exists in this tenant."));
  });

  it("not_found then the re-read is not_found too: the form is gone (writable=false), the notice stays", async () => {
    await openDetail();
    const reads = vi.mocked(getUser).mock.calls.length;
    vi.mocked(getUser).mockResolvedValue(fail("not_found") as never);
    setRoles.mockResolvedValue(fail("not_found") as never);
    fireEvent.click(box(/^tenant admin$/i));
    await save();
    await noDialog();
    await waitFor(() => expect(within(roles()).queryByRole("checkbox")).toBeNull());
    expect(saveButton()).toBeNull();
    expect(within(roles()).getByRole("status").textContent).toBe("This user no longer exists in this tenant.");
    expect(vi.mocked(getUser).mock.calls.length).toBeGreaterThan(reads);
  });

  it("a throw that is not an AdminRequestError (BFF/network) => dialog closes, ROLES_UNCERTAIN, sent once", async () => {
    setRoles.mockRejectedValue(new Error("boom-xyz"));
    await openDetail();
    fireEvent.click(box(/^tenant admin$/i));
    await save();
    await noDialog();
    await waitFor(() => expect(within(roles()).getByRole("status").textContent).toBe(ROLES_UNCERTAIN));
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(setRoles).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("boom-xyz");
  });

  it("step_up_required => StepUpAlert in the dialog, no stored intent", async () => {
    setRoles.mockResolvedValue(fail("step_up_required") as never);
    await openDetail();
    fireEvent.click(box(/^tenant admin$/i));
    const d = await save();
    expect((await within(d).findByRole("alert")).textContent).toContain("Confirm your identity to continue.");
    expect(within(d).getByRole("button", { name: "Confirm identity" })).toBeTruthy();
    expect(sessionStorage.getItem("fea:stepup")).toBeNull();
    expect(document.body.textContent).not.toContain(DESC);
  });
});

describe("a11y", () => {
  it("fieldset + legend, labels, hints by aria-describedby, status region always rendered", async () => {
    await openDetail();
    const group = within(roles()).getByRole("group", { name: "Admin roles" });
    expect(group.tagName).toBe("FIELDSET");
    for (const [name, hint] of [
      [/^tenant admin$/i, "this tenant"],
      [/^super admin$/i, "every tenant, every resource and the signing keys"],
    ] as const) {
      const input = box(name);
      expect(document.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
      expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toContain(hint);
    }
    expect(within(roles()).getByRole("status").textContent).toBe("");
    expect(screen.getByRole("heading", { name: "Admin roles" }).getAttribute("tabindex")).toBe("-1");
  });
});
