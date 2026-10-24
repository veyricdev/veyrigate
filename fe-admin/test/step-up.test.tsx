// Step-up round-trip without losing the form + Query error policy (run 43 F3). The harness form
// lives in test/ only (A5 ships no form; the real one is A6.1).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, Suspense, use, useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "sonner";
import { createQueryClient } from "@/features/admin-api/query-client";
import { adminKeys } from "@/features/admin-api/keys";
import { clearIntent, startStepUp, takeIntent, useStepUpDraft } from "@/features/admin-api/step-up";
import { AdminRequestError, type AdminApiErrorCode } from "@/features/admin-api/types";
import { SignOutButton } from "@/features/auth/sign-out-button";
import { updateClient } from "@/features/admin-api/clients";
import { useUpdateClient } from "@/features/admin-api/hooks";

vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));
vi.mock("@/features/admin-api/clients", () => ({
  listClients: vi.fn(),
  getClient: vi.fn(),
  updateClient: vi.fn(),
}));
// Detail pages of a confidential client also list its secrets (run 45): empty by default.
vi.mock("@/features/admin-api/secrets", () => ({
  listSecrets: vi.fn(async () => ({ ok: true, data: { items: [] } })),
  issueSecret: vi.fn(),
  revokeSecret: vi.fn(),
}));

const KEY = "fea:stepup";
const ACTION = "client.update";
const PATH = "/clients/app-1?tab=uris";
const SECRET = "s3cr3t-CANARY";
/** The form's allowlist: only these fields may survive a step-up (no secret field). */
const FormSchema = z.object({ redirectUris: z.string().max(4096) });

const failWith = (code: AdminApiErrorCode, uncertain = false) =>
  new AdminRequestError({ code, message: "m", ...(uncertain ? { uncertain: true as const } : {}) });

let assign: ReturnType<typeof vi.fn>;
let queryClient: QueryClient;

beforeEach(() => {
  sessionStorage.clear();
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, pathname: "/clients/app-1", search: "?tab=uris", assign });
  queryClient = createQueryClient();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type HarnessProps = { sub: string; path?: string; submit: (v: unknown) => Promise<unknown> };

/** Reads the draft once (StrictMode-safe), then (re)mounts the form with it. */
function Harness(props: HarnessProps) {
  const restored = useStepUpDraft(FormSchema, ACTION, props.path ?? PATH, props.sub);
  return <HarnessForm key={restored ? "restored" : "blank"} {...props} restored={restored} />;
}

function HarnessForm({ sub, path = PATH, submit, restored }: HarnessProps & { restored: z.infer<typeof FormSchema> | null }) {
  const [redirectUris, setRedirectUris] = useState(restored?.redirectUris ?? "");
  const [secret, setSecret] = useState("");
  const mutation = useMutation({
    mutationFn: submit,
    onError: (err) => {
      if (err instanceof AdminRequestError && err.code === "step_up_required") {
        startStepUp(FormSchema, { action: ACTION, path, sub, payload: { redirectUris, secret } });
      }
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate({ redirectUris, secret });
      }}
    >
      {restored && <p role="status">You just confirmed your identity. Check the values, then submit again.</p>}
      <label>
        Redirect URIs
        <input value={redirectUris} onChange={(e) => setRedirectUris(e.target.value)} />
      </label>
      <label>
        Secret
        <input value={secret} onChange={(e) => setSecret(e.target.value)} />
      </label>
      <button type="submit">Save</button>
    </form>
  );
}

// StrictMode double-invokes initializers and effects: the draft must still be restored once.
const mount = (props: HarnessProps) =>
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Harness {...props} />
      </QueryClientProvider>
    </StrictMode>,
  );
const uris = () => (screen.getByLabelText("Redirect URIs") as HTMLInputElement).value;

/** Fill the form, submit, get `step_up_required`, unmount (the browser leaves for the IdP). */
async function stepUpOnce(submit = vi.fn(async () => Promise.reject(failWith("step_up_required")))) {
  const view = mount({ sub: "u1", submit });
  fireEvent.change(screen.getByLabelText("Redirect URIs"), { target: { value: "https://app.example/cb2" } });
  fireEvent.change(screen.getByLabelText("Secret"), { target: { value: SECRET } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(assign).toHaveBeenCalled());
  view.unmount();
  return submit;
}

describe("step-up round-trip", () => {
  it("step_up_required => intent saved (allowlisted), then /auth/login?stepup=1 with returnTo", async () => {
    const submit = await stepUpOnce();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/auth/login?stepup=1&returnTo=${encodeURIComponent(PATH)}`);
    const raw = sessionStorage.getItem(KEY)!;
    const stored = JSON.parse(raw);
    expect(stored).toMatchObject({ v: 1, action: ACTION, path: PATH, sub: "u1", payload: { redirectUris: "https://app.example/cb2" } });
    expect(stored.exp - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(stored.exp - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(raw).not.toContain(SECRET);
    expect(Object.keys(stored.payload)).toEqual(["redirectUris"]);
  });

  it("back on the page (same viewer): values restored, NOT re-sent; Save sends exactly once", async () => {
    const first = await stepUpOnce();
    const submit = vi.fn(async (_values: unknown) => ({ ok: true }));
    mount({ sub: "u1", submit });
    expect(uris()).toBe("https://app.example/cb2");
    expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("status").textContent).toMatch(/submit again/);
    expect(sessionStorage.getItem(KEY)).toBeNull(); // single use
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(submit).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]![0]).toEqual({ redirectUris: "https://app.example/cb2", secret: "" });
  });

  it("draft is taken after commit: a mount render that suspends and is thrown away does not consume it", async () => {
    await stepUpOnce();
    let resolve!: () => void;
    const pending = new Promise<void>((r) => (resolve = r));
    function Slow() {
      use(pending);
      return null;
    }
    await act(async () => {
      render(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <Suspense fallback={<p>Loading</p>}>
              <Harness sub="u1" submit={vi.fn()} />
              <Slow />
            </Suspense>
          </QueryClientProvider>
        </StrictMode>,
      );
    });
    expect(screen.getByText("Loading")).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      resolve();
    });
    await waitFor(() => expect(uris()).toBe("https://app.example/cb2"));
    expect(screen.getByRole("status").textContent).toMatch(/submit again/);
  });

  it.each([
    ["another viewer (shared machine)", { sub: "u2" }],
    ["another page", { sub: "u1", path: "/clients/app-2" }],
  ])("%s => empty form, intent dropped", async (_, props) => {
    await stepUpOnce();
    mount({ ...props, submit: vi.fn() });
    expect(uris()).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("expired (> 10 min) => empty form, intent dropped", async () => {
    await stepUpOnce();
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000 + 1, toFake: ["Date"] });
    mount({ sub: "u1", submit: vi.fn() });
    expect(uris()).toBe("");
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("another action => null (and still consumed)", async () => {
    await stepUpOnce();
    expect(takeIntent(FormSchema, "client.delete", PATH, "u1")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    ["payload off-schema", (s: Record<string, unknown>) => ({ ...s, payload: { redirectUris: 42 } })],
    ["unknown version", (s: Record<string, unknown>) => ({ ...s, v: 2 })],
    ["exp pushed into the future", (s: Record<string, unknown>) => ({ ...s, exp: Date.now() + 24 * 3600_000 })],
  ])("tampered intent (%s) => rejected", async (_, tamper) => {
    await stepUpOnce();
    sessionStorage.setItem(KEY, JSON.stringify(tamper(JSON.parse(sessionStorage.getItem(KEY)!))));
    mount({ sub: "u1", submit: vi.fn() });
    expect(uris()).toBe("");
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("corrupted JSON => rejected, no throw", () => {
    sessionStorage.setItem(KEY, "{not json");
    expect(takeIntent(FormSchema, ACTION, PATH, "u1")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("storage blocked => still steps up (draft lost, toast shown)", async () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.stubGlobal("sessionStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    await stepUpOnce();
    expect(vi.mocked(toast.warning)).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith(`/auth/login?stepup=1&returnTo=${encodeURIComponent(PATH)}`);
    expect(takeIntent(FormSchema, ACTION, PATH, "u1")).toBeNull(); // reads fail closed too
    clearIntent(); // no throw
  });

  it("sign-out drops a pending intent before the POST", async () => {
    // Signed out 20 s "ago" (fake Date): the 10 s signing-out window (DEBT-374) is already over once
    // afterEach restores the real clock, so later tests get automatic sign-in back.
    vi.useFakeTimers({ now: Date.now() - 20_000, toFake: ["Date"] });
    await stepUpOnce();
    render(
      <QueryClientProvider client={queryClient}>
        <SignOutButton />
      </QueryClientProvider>,
    );
    const form = screen.getByRole("button", { name: "Sign out" }).closest("form")!;
    form.addEventListener("submit", (e) => e.preventDefault()); // no navigation in the test DOM
    fireEvent.submit(form);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    clearIntent(); // idempotent
  });
});

describe("Query policy", () => {
  function runQuery(queryFn: () => Promise<unknown>) {
    queryClient.setQueryDefaults(["t"], { retryDelay: 0 });
    return renderHook(() => useQuery({ queryKey: ["t"], queryFn }), {
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
  }

  it.each(["step_up_required", "forbidden", "not_found", "invalid_request", "conflict"] as const)(
    "%s => no retry (queryFn runs once)",
    async (code) => {
      const fn = vi.fn(async () => Promise.reject(failWith(code)));
      const { result } = runQuery(fn);
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(fn).toHaveBeenCalledTimes(1);
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unavailable", () => failWith("unavailable")],
    ["generic 500/503 (thrown)", () => new Error("Internal error (request id x)")],
  ])("%s => retried exactly twice", async (_, make) => {
    const fn = vi.fn(async () => Promise.reject(make()));
    const { result } = runQuery(fn);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("unauthenticated => no retry, full reload to /auth/login with returnTo", async () => {
    const fn = vi.fn(async () => Promise.reject(failWith("unauthenticated")));
    const { result } = runQuery(fn);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/auth/login?returnTo=${encodeURIComponent("/clients/app-1?tab=uris")}`);
  });

  it("mutations: never retried, not kept in the cache", () => {
    expect(queryClient.getDefaultOptions().mutations).toEqual({ retry: 0, gcTime: 0 });
  });
});

describe("useUpdateClient invalidation", () => {
  const update = vi.mocked(updateClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const input = { clientId: "app-1", patch: { scopes: ["openid"] } };

  it.each([
    ["success", { ok: true, data: {} }, true],
    ["uncertain failure", { ok: false, error: { code: "unavailable", message: "m", uncertain: true } }, true],
    ["certain failure (step_up_required)", { ok: false, error: { code: "step_up_required", message: "m" } }, false],
  ] as const)("%s => invalidate clients.all: %s", async (_, result, invalidated) => {
    update.mockResolvedValue(result as never);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const { result: hook } = renderHook(() => useUpdateClient(), { wrapper });
    await act(() => hook.current.mutateAsync(input).catch(() => undefined));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ data: input });
    if (invalidated) expect(spy).toHaveBeenCalledWith({ queryKey: adminKeys.clients.all });
    else expect(spy).not.toHaveBeenCalled();
    update.mockReset();
  });
});
