import { describe, expect, it } from "vitest";
import { getRouter } from "@/router";

describe("router", () => {
  it("registers the index route from the generated route tree", () => {
    const router = getRouter();
    expect(Object.keys(router.routesByPath)).toContain("/");
  });
});
