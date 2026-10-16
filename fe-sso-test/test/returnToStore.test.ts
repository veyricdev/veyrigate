// @vitest-environment node
import { describe, it, expect } from "vitest";
import { saveReturnTo, takeReturnTo } from "../src/oidc/returnToStore";
import { memStore } from "./helpers/env";

const ORIGIN = "http://localhost:5173";

describe("returnTo transient store (validate on write AND read)", () => {
  it("persists and returns a sanitized safe path", () => {
    const store = memStore();
    saveReturnTo(store, "/profile?x=1", ORIGIN);
    expect(store.getItem("oidc:return_to")).toBe("/profile?x=1");
  });

  it("normalises an unsafe candidate to `/` on write", () => {
    const store = memStore();
    saveReturnTo(store, "https://evil", ORIGIN);
    expect(store.getItem("oidc:return_to")).toBe("/");
  });

  it("re-sanitizes on read: a tampered transient never redirects off-origin", () => {
    // Simulate another tab seeding a hostile value directly into storage.
    const store = memStore({ "oidc:return_to": "//evil" });
    expect(takeReturnTo(store, ORIGIN)).toBe("/");
  });

  it("read is one-shot: consumes the stored value", () => {
    const store = memStore({ "oidc:return_to": "/tokens" });
    expect(takeReturnTo(store, ORIGIN)).toBe("/tokens");
    expect(store.getItem("oidc:return_to")).toBeNull();
    expect(takeReturnTo(store, ORIGIN)).toBe("/");
  });

  it("missing transient reads as `/`", () => {
    expect(takeReturnTo(memStore(), ORIGIN)).toBe("/");
  });
});