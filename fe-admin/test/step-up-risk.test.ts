// Tester risk matrix for the step-up intent (run 43, tester): the stored value is untrusted (any
// JSON shape, injected fields, near-miss bindings); restoring is exact-match and single use.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { saveIntent, startStepUp, takeIntent } from "@/features/admin-api/step-up";

vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

const KEY = "fea:stepup";
const ACTION = "client.update";
const PATH = "/clients/app-1?tab=uris";
const Form = z.object({ redirectUris: z.string().max(4096) });
const good = () => ({ v: 1, action: ACTION, path: PATH, sub: "u1", payload: { redirectUris: "https://a.example/cb" }, exp: Date.now() + 60_000 });

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const put = (v: unknown) => sessionStorage.setItem(KEY, typeof v === "string" ? v : JSON.stringify(v));
const take = (path = PATH, sub = "u1", action = ACTION) => takeIntent(Form, action, path, sub);

describe("stored value of any shape is refused and consumed", () => {
  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["string", '"x"'],
    ["number", "42"],
    ["empty", ""],
    ["exp as string", { ...good(), exp: String(Date.now() + 60_000) }],
    ["exp NaN-ish", { ...good(), exp: null }],
    ["v as string", { ...good(), v: "1" }],
    ["missing sub", { ...good(), sub: undefined }],
    ["payload null", { ...good(), payload: null }],
    ["payload array", { ...good(), payload: ["https://a.example/cb"] }],
    ["payload too long", { ...good(), payload: { redirectUris: "x".repeat(4097) } }],
  ])("%s", (_, v) => {
    put(v);
    expect(take()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe("binding is exact", () => {
  it.each([
    ["path + extra query", PATH + "&x=1"],
    ["path without query", "/clients/app-1"],
    ["path trailing slash", "/clients/app-1/?tab=uris"],
    ["path case", "/Clients/app-1?tab=uris"],
    ["path encoded", "/clients/app%2D1?tab=uris"],
  ])("%s => null", (_, path) => {
    put(good());
    expect(take(path)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    ["sub prefix", "u10"],
    ["sub empty", ""],
    ["sub case", "U1"],
  ])("%s => null", (_, sub) => {
    put(good());
    expect(take(PATH, sub)).toBeNull();
  });

  it("action case / prefix => null", () => {
    put(good());
    expect(take(PATH, "u1", "client.updateX")).toBeNull();
    put(good());
    expect(take(PATH, "u1", "Client.update")).toBeNull();
  });

  it("exp exactly now => null; 1 ms before exp => restored", () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    put({ ...good(), exp: 1_000_000 });
    expect(take()).toBeNull();
    put({ ...good(), exp: 1_000_001 });
    expect(take()).toEqual({ redirectUris: "https://a.example/cb" });
  });
});

describe("payload injected by hand is filtered by the form allowlist", () => {
  it("extra secret / token / __proto__ keys never come back", () => {
    put(
      `{"v":1,"action":"${ACTION}","path":"${PATH}","sub":"u1","exp":${Date.now() + 60_000},` +
        `"payload":{"redirectUris":"https://a.example/cb","clientSecret":"S","accessToken":"T","__proto__":{"polluted":1}}}`,
    );
    const out = take() as Record<string, unknown>;
    expect(out).toEqual({ redirectUris: "https://a.example/cb" });
    expect(Object.keys(out)).toEqual(["redirectUris"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("saveIntent itself never writes a field outside the schema", () => {
    expect(saveIntent(Form, { action: ACTION, path: PATH, sub: "u1", payload: { redirectUris: "x", secret: "S", token: "T" } })).toBe(true);
    const raw = sessionStorage.getItem(KEY)!;
    expect(raw).not.toMatch(/"secret"|"token"|"S"|"T"/);
  });

  it("invalid draft => nothing saved, toast, still redirected to step-up", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    startStepUp(Form, { action: ACTION, path: PATH, sub: "u1", payload: { redirectUris: 5 } });
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(assign).toHaveBeenCalledWith(`/auth/login?stepup=1&returnTo=${encodeURIComponent(PATH)}`);
  });

  // DEBT-299 (known, not blocking: no auto-submit, the user reviews and a toast says the draft was
  // lost): a failed save leaves an older unconsumed intent in place, which is then restored.
  // `it.fails` turns red once saveIntent clears the key first; switch it back to `it` then.
  it.fails("an older pending intent is not left behind when a newer draft cannot be saved", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    // 1st step-up saved draft A, but the user came back on another page (A not consumed).
    expect(saveIntent(Form, { action: ACTION, path: PATH, sub: "u1", payload: { redirectUris: "A-old" } })).toBe(true);
    // 2nd step-up on the same form with a draft that fails the schema.
    startStepUp(Form, { action: ACTION, path: PATH, sub: "u1", payload: { redirectUris: 5 } });
    // Back on the form: the stale draft A must not be offered as the user's current change.
    expect(take()).toBeNull();
  });
});
