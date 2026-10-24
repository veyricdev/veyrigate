// Run 51 retry 2: Sign out while dashboard queries / a mutation are still running. The session ends
// server-side, the in-flight calls come back `unauthenticated`, and nothing may navigate to
// /auth/login (it would abort the logout POST before the IdP end_session => silent sign-in again).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { beginSignOut, createQueryClient, isSigningOut, signInAgain } from "@/features/admin-api/query-client";
import { reauthenticate, startStepUp } from "@/features/admin-api/step-up";
import { AdminRequestError, type AdminApiFailure } from "@/features/admin-api/types";
import { SignOutButton } from "@/features/auth/sign-out-button";
import { z } from "@/lib/zod";

const unauthenticated = () =>
  new AdminRequestError({ code: "unauthenticated", message: "Session expired" } as AdminApiFailure);

function deferred() {
  let reject!: (err: unknown) => void;
  const promise = new Promise<never>((_, r) => (reject = r));
  return { promise, reject };
}

let assign: ReturnType<typeof vi.fn>;
let submits: SubmitEvent[];
const onSubmit = (event: Event) => submits.push(event as SubmitEvent);

// Only Date is faked (waitFor keeps real timers). The clock only moves forward: each test starts
// past the sign-out window a previous test may have opened (DEBT-374), whatever the test order.
let clock = Date.now();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  assign = vi.fn();
  submits = [];
  vi.stubGlobal("location", { ...window.location, pathname: "/", search: "", assign });
  document.addEventListener("submit", onSubmit); // bubble phase: runs after React's handler
});
afterEach(() => {
  cleanup();
  document.removeEventListener("submit", onSubmit);
  vi.unstubAllGlobals();
  clock = Date.now() + 10_001;
  vi.useRealTimers();
});

function Dashboard({ query, mutation }: { query: Promise<never>; mutation: Promise<never> }) {
  const q = useQuery({ queryKey: ["dash"], queryFn: () => query, retry: false });
  const m = useMutation({ mutationFn: () => mutation });
  return (
    <>
      <p>{q.status}</p>
      <button type="button" onClick={() => m.mutate()}>
        Run
      </button>
      <SignOutButton />
    </>
  );
}

function renderDashboard(client: QueryClient) {
  const query = deferred();
  const mutation = deferred();
  render(
    <QueryClientProvider client={client}>
      <Dashboard query={query.promise} mutation={mutation.promise} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  return { query, mutation };
}

const signOut = () => fireEvent.submit(screen.getByRole("button", { name: "Sign out" }).closest("form")!);

describe("sign-out race (query / mutation still pending)", () => {
  it("control: without signing out, an unauthenticated query does send the browser to sign in again", async () => {
    const { query } = renderDashboard(createQueryClient());
    await act(async () => query.reject(unauthenticated()));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/auth/login?returnTo=%2F"));
  });

  it("Sign out pressed first: pending calls failing unauthenticated never navigate, the logout POST goes on", async () => {
    const client = createQueryClient();
    const { query, mutation } = renderDashboard(client);
    expect(client.isFetching()).toBe(1);
    expect(client.isMutating()).toBe(1);

    signOut();
    expect(submits).toHaveLength(1);
    expect(submits[0].defaultPrevented).toBe(false); // the plain form POST is not stopped
    expect(client.isFetching()).toBe(0); // in-flight queries cancelled

    await act(async () => {
      query.reject(unauthenticated());
      mutation.reject(unauthenticated());
    });
    await waitFor(() => expect(client.isMutating()).toBe(0));
    // step-up redirects are switched off as well, and no draft is kept
    startStepUp(z.object({}), { action: "client.update", path: "/clients/a", sub: "u1", payload: {} });
    reauthenticate("/clients/a");
    expect(sessionStorage.getItem("fea:stepup")).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

});

describe("DEBT-374: the signing-out window expires on its own (10 s)", () => {
  const stepUp = () =>
    startStepUp(z.object({}), { action: "client.update", path: "/clients/a", sub: "u1", payload: {} });
  const tryAll = () => {
    signInAgain();
    reauthenticate("/clients/a");
    stepUp();
  };

  it("t+9 999 ms: still muted; t+10 001 ms: signInAgain, reauthenticate and startStepUp navigate again", () => {
    const start = Date.now();
    beginSignOut(createQueryClient());
    vi.setSystemTime(start + 9_999);
    expect(isSigningOut()).toBe(true);
    tryAll();
    expect(assign).not.toHaveBeenCalled();

    vi.setSystemTime(start + 10_001);
    expect(isSigningOut()).toBe(false);
    tryAll();
    expect(assign.mock.calls).toEqual([
      ["/auth/login?returnTo=%2F"],
      ["/auth/login?stepup=1&returnTo=%2Fclients%2Fa"],
      ["/auth/login?stepup=1&returnTo=%2Fclients%2Fa"],
    ]);
  });

  it("a second Sign out extends the window from that moment", () => {
    const start = Date.now();
    beginSignOut(createQueryClient());
    vi.setSystemTime(start + 6_000);
    beginSignOut(createQueryClient());
    vi.setSystemTime(start + 15_999);
    tryAll();
    expect(assign).not.toHaveBeenCalled();
    vi.setSystemTime(start + 16_001);
    signInAgain();
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("the window is not tied to a pageshow event any more", () => {
    beginSignOut(createQueryClient());
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(isSigningOut()).toBe(true);
  });
});
