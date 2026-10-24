// Run 51 retry 2: Sign out while dashboard queries / a mutation are still running. The session ends
// server-side, the in-flight calls come back `unauthenticated`, and nothing may navigate to
// /auth/login (it would abort the logout POST before the IdP end_session => silent sign-in again).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { createQueryClient } from "@/features/admin-api/query-client";
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

beforeEach(() => {
  assign = vi.fn();
  submits = [];
  vi.stubGlobal("location", { ...window.location, pathname: "/", search: "", assign });
  document.addEventListener("submit", onSubmit); // bubble phase: runs after React's handler
});
afterEach(() => {
  cleanup();
  document.removeEventListener("submit", onSubmit);
  vi.unstubAllGlobals();
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

  it("page restored from the back/forward cache: automatic sign-in works again", async () => {
    const event = Object.assign(new Event("pageshow"), { persisted: true });
    window.dispatchEvent(event);
    const { query } = renderDashboard(createQueryClient());
    await act(async () => query.reject(unauthenticated()));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
  });
});
