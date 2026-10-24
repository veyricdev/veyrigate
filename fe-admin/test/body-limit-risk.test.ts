// @vitest-environment node
// Run 52 (tester): boundaries and odd Content-Length values of the DEBT-370 body limit, on the pure
// function (the entry wiring is covered by server-entry.test.ts).
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, rejectBody } from "@/server/body-limit";

const req = (method: string, headers: Record<string, string> = {}, body?: BodyInit) =>
  new Request("http://localhost/_serverFn/x", { method, headers, body });

describe("rejectBody boundaries", () => {
  it("limit is 64 KiB", () => expect(MAX_BODY_BYTES).toBe(65_536));

  it.each([
    ["0", undefined],
    ["65535", undefined],
    ["65536", undefined],
    ["065536", undefined],
    ["65537", 413],
    ["0065537", 413],
    ["99999999999999999999999", 413],
    ["", 400],
    ["+10", 400],
    ["10, 10", 400],
    ["10 10", 400],
  ])("POST Content-Length %j => %s", async (length, status) => {
    const res = rejectBody(req("POST", { "content-length": length }));
    expect(res?.status).toBe(status);
    if (res) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).not.toContain(length || "\u0000");
    }
  });

  it("POST without Content-Length and without body => passes (router decides)", () => {
    expect(rejectBody(req("POST"))).toBeUndefined();
  });

  it("GET/HEAD/OPTIONS are never limited, whatever Content-Length says", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(rejectBody(req(method, { "content-length": "999999999" }))).toBeUndefined();
      expect(rejectBody(req(method, { "content-length": "abc" }))).toBeUndefined();
    }
  });

  it("lower-case or unknown methods with a too-large body are limited", () => {
    for (const method of ["PROPFIND", "post"]) {
      expect(rejectBody(req(method, { "content-length": "70000" }))?.status).toBe(413);
    }
  });
});
