// @vitest-environment node
// Tester (run 43): the DEBT-282 "dependency down" flag is per request even when requests run
// interleaved on the same event loop (AsyncLocalStorage), including a flag set after awaits.
import { describe, expect, it } from "vitest";
import { markUnavailable, withUnavailableStatus } from "@/server/unavailable";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("withUnavailableStatus under concurrency", () => {
  it("A flags mid-flight while B is in flight: A => 503, B => 500 (no leak either way)", async () => {
    const aStarted = deferred();
    const bStarted = deferred();
    const aFlagged = deferred();
    const a = withUnavailableStatus(async () => {
      aStarted.resolve();
      await bStarted.promise;
      markUnavailable();
      aFlagged.resolve();
      await new Promise((r) => setTimeout(r, 5));
      return new Response("a", { status: 500 });
    });
    const b = withUnavailableStatus(async () => {
      bStarted.resolve();
      await aStarted.promise;
      await aFlagged.promise; // B finishes after A set its flag
      return new Response("b", { status: 500 });
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(503);
    expect(ra.headers.get("cache-control")).toBe("no-store");
    expect(await ra.text()).toBe("a");
    expect(rb.status).toBe(500);
    expect(rb.headers.get("cache-control")).toBeNull();
  });

  it("50 interleaved requests, odd ones flagged after a timer: exactly the odd ones become 503", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        withUnavailableStatus(async () => {
          await new Promise((r) => setTimeout(r, (i * 7) % 11));
          if (i % 2) markUnavailable();
          await Promise.resolve();
          return new Response(null, { status: 500 });
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array.from({ length: 50 }, (_, i) => (i % 2 ? 503 : 500)));
  });

  it("flag set inside a nested async callback (setTimeout chain) still belongs to its request", async () => {
    const res = await withUnavailableStatus(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => {
            void Promise.resolve().then(() => {
              markUnavailable();
              resolve(new Response(null, { status: 500 }));
            });
          }, 1);
        }),
    );
    expect(res.status).toBe(503);
  });

  it("a flagged request answering 200/302/404 keeps its status", async () => {
    for (const status of [200, 302, 404]) {
      const res = await withUnavailableStatus(async () => {
        markUnavailable();
        return new Response(null, { status });
      });
      expect(res.status).toBe(status);
    }
  });
});
