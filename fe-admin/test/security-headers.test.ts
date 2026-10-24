// @vitest-environment node
// A7 (DEBT-269/298): the server-entry wrapper sets a strict CSP with a fresh per-response nonce and
// the security headers on every response, without reading the body or dropping a Set-Cookie.
import { describe, expect, it, vi } from "vitest";
import { currentCspNonce, withSecurityHeaders } from "@/server/security-headers";
import { markUnavailable, withUnavailableStatus } from "@/server/unavailable";

const ISSUER = "http://localhost:3000";

function csp(res: Response): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of (res.headers.get("content-security-policy") ?? "").split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}
const nonceOf = (res: Response) => /'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];

describe("withSecurityHeaders: CSP", () => {
  it("(a) exactly the agreed directives; script-src has no unsafe-inline/eval/strict-dynamic/*", async () => {
    const res = await withSecurityHeaders(() => new Response("x"), { appUrl: "http://localhost:4000", issuer: ISSUER });
    const map = csp(res);
    const nonce = nonceOf(res)!;
    expect(Object.fromEntries(map)).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", `'nonce-${nonce}'`],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'"],
      "connect-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'self'", ISSUER],
      "frame-ancestors": ["'none'"],
    });
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "*"]) {
      expect(map.get("script-src")).not.toContain(bad);
    }
  });

  it("(b) nonce ≥ 16 random bytes, new per response, the one seen inside the handler; none outside", async () => {
    expect(() => currentCspNonce()).not.toThrow();
    expect(currentCspNonce()).toBeUndefined();
    let inside: string | undefined;
    const first = await withSecurityHeaders(async () => {
      await Promise.resolve();
      inside = currentCspNonce();
      return new Response("x");
    });
    const second = await withSecurityHeaders(() => new Response("x"));
    expect(Buffer.from(nonceOf(first)!, "base64").length).toBeGreaterThanOrEqual(16);
    expect(inside).toBe(nonceOf(first));
    expect(nonceOf(second)).not.toBe(nonceOf(first));
    expect(currentCspNonce()).toBeUndefined();
  });

  it("(i) form-action is the issuer's origin when given, only 'self' without one", async () => {
    const withIssuer = await withSecurityHeaders(() => new Response("x"), { issuer: "https://idp.example/tenant/x" });
    expect(csp(withIssuer).get("form-action")).toEqual(["'self'", "https://idp.example"]);
    const without = await withSecurityHeaders(() => new Response("x"));
    expect(csp(without).get("form-action")).toEqual(["'self'"]);
  });
});

describe("withSecurityHeaders: other headers", () => {
  it("sets XFO, nosniff, referrer, permissions and opener policies", async () => {
    const res = await withSecurityHeaders(() => new Response("x"));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("(c) a 303 with two Set-Cookie keeps both, in order", async () => {
    const headers = new Headers({ location: "/x" });
    headers.append("set-cookie", "a=1; Path=/; HttpOnly");
    headers.append("set-cookie", "b=; Path=/; Max-Age=0");
    const res = await withSecurityHeaders(() => new Response(null, { status: 303, headers }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/x");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/; HttpOnly", "b=; Path=/; Max-Age=0"]);
  });

  it("(d) wraps Response.redirect (immutable headers) without throwing", async () => {
    const res = await withSecurityHeaders(() => Response.redirect("http://localhost:4000/next", 302));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:4000/next");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("(e) keeps an existing cache-control, otherwise no-store", async () => {
    const cached = await withSecurityHeaders(
      () => new Response("x", { headers: { "cache-control": "private, max-age=60" } }),
    );
    expect(cached.headers.get("cache-control")).toBe("private, max-age=60");
    const plain = await withSecurityHeaders(() => new Response("x"));
    expect(plain.headers.get("cache-control")).toBe("no-store");
  });

  it("(f) HSTS only when the app URL is https", async () => {
    const https = await withSecurityHeaders(() => new Response("x"), { appUrl: "https://admin.example" });
    expect(https.headers.get("strict-transport-security")).toBe("max-age=31536000");
    const http = await withSecurityHeaders(() => new Response("x"), { appUrl: "http://localhost:4000" });
    expect(http.headers.has("strict-transport-security")).toBe(false);
    const none = await withSecurityHeaders(() => new Response("x"));
    expect(none.headers.has("strict-transport-security")).toBe(false);
  });

  it("(g) forwards a two-chunk body stream intact", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("<p>one</p>"));
        c.enqueue(enc.encode("<p>two</p>"));
        c.close();
      },
    });
    const res = await withSecurityHeaders(() => new Response(body, { headers: { "content-type": "text/html" } }));
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toBe("<p>one</p><p>two</p>");
  });

  it("(h) the 503 from withUnavailableStatus and the env-error 500 carry the headers too", async () => {
    const unavailable = await withSecurityHeaders(() =>
      withUnavailableStatus(() => {
        markUnavailable();
        return new Response("down", { status: 500 });
      }),
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(csp(unavailable).get("frame-ancestors")).toEqual(["'none'"]);
    expect(unavailable.headers.get("x-content-type-options")).toBe("nosniff");

    const envError = await withSecurityHeaders(
      () => new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } }),
    );
    expect(envError.status).toBe(500);
    expect(csp(envError).get("form-action")).toEqual(["'self'"]);
    expect(envError.headers.get("x-frame-options")).toBe("DENY");
    expect(envError.headers.get("cache-control")).toBe("no-store");
  });
});

describe("withSecurityHeaders: DEBT-368 a throwing handler", () => {
  it("answers a fixed 500 that still carries CSP, nosniff and no-store; logs a request id, no detail out", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await withSecurityHeaders(() => {
        throw new Error("CANARY-detail");
      });
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Server Error");
      expect(csp(res).get("frame-ancestors")).toEqual(["'none'"]);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toMatch(/request id [0-9a-f-]{36}/);
    } finally {
      log.mockRestore();
    }
  });

  it("an async rejection is caught the same way", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await withSecurityHeaders(async () => Promise.reject(new Error("boom")));
      expect(res.status).toBe(500);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    } finally {
      log.mockRestore();
    }
  });
});
