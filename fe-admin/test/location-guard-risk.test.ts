// @vitest-environment node
// Run 60 tester (DEBT-446): edge cases of the Location guard beyond the dev's matrix. Origins are compared
// after WHATWG normalisation (default port, IDN => punycode, IPv6 compression, case), so equivalent
// spellings pass and look-alikes do not. Pure checks: no I/O.
import { describe, expect, it, vi } from "vitest";
import { withSecurityHeaders } from "@/server/security-headers";

async function run(location: string | string[], site: { appUrl?: string; issuer?: string }) {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const headers = new Headers();
    for (const l of [location].flat()) headers.append("location", l);
    headers.append("set-cookie", "fea_tx=t; Path=/; HttpOnly");
    const res = await withSecurityHeaders(() => new Response(null, { status: 302, headers }), site);
    const lines = log.mock.calls.map((c) => String(c[0]));
    return { res, lines };
  } finally {
    log.mockRestore();
  }
}

async function expectKept(location: string, site: { appUrl?: string; issuer?: string }) {
  const { res, lines } = await run(location, site);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(location);
  expect(res.headers.getSetCookie()).toEqual(["fea_tx=t; Path=/; HttpOnly"]);
  expect(lines).toEqual([]);
}

async function expectBlocked(location: string | string[], site: { appUrl?: string; issuer?: string }) {
  const { res, lines } = await run(location, site);
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("Not Found");
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("blocked an off-origin Location (status 302)");
  for (const leak of ["evil", "xn--", "bücher", "[::", "blob", "idp.example", "fea_tx"]) {
    expect(lines[0]).not.toContain(leak);
  }
}

describe("run60-tester DEBT-446: default port spelled out", () => {
  const site = { appUrl: "https://admin.example", issuer: "https://idp.example:443/realm" };
  it.each([
    "https://idp.example:443/authorize?client_id=a",
    "https://idp.example/authorize",
    "https://admin.example:443/next",
    "HTTPS://IDP.EXAMPLE:443/x",
  ])("DEBT-446 kept: %s (same origin once :443 is dropped)", (l) => expectKept(l, site));
  it.each([
    "http://idp.example:443/authorize", // http on 443 is another origin
    "http://idp.example/authorize",
    "https://idp.example:8443/authorize",
    "https://idp.example:4430/authorize",
  ])("DEBT-446 blocked: %s", (l) => expectBlocked(l, site));
});

describe("run60-tester DEBT-446: IDN host", () => {
  const site = { appUrl: "https://bücher.example", issuer: "https://idp.example" };
  it.each(["https://xn--bcher-kva.example/x", "https://bücher.example/x", "https://BÜCHER.example/x"])(
    "DEBT-446 kept: %s (punycode-equal)",
    (l) => expectKept(l, site),
  );
  it.each(["https://bucher.example/x", "https://xn--bcher-kva.example.evil/x", "https://bücher.example.evil/"])(
    "DEBT-446 blocked look-alike: %s",
    (l) => expectBlocked(l, site),
  );
});

describe("run60-tester DEBT-446: IPv6 host", () => {
  const site = { appUrl: "http://[::1]:3000", issuer: "http://[::1]:4000" };
  it.each(["http://[::1]:3000/x", "http://[0:0:0:0:0:0:0:1]:3000/x", "http://[::1]:4000/authorize"])(
    "DEBT-446 kept: %s (compressed form equal)",
    (l) => expectKept(l, site),
  );
  it.each(["http://[::2]:3000/x", "http://[::1]:3001/x", "http://[::ffff:127.0.0.1]:3000/", "http://127.0.0.1:3000/"])(
    "DEBT-446 blocked: %s",
    (l) => expectBlocked(l, site),
  );
});

describe("run60-tester DEBT-446: spellings that change the authority", () => {
  const site = { appUrl: "http://localhost:3000", issuer: "http://localhost:4000/realm" };
  it.each([
    " //evil.example/", // leading space is stripped by the URL parser (and by browsers)
    "\t//evil.example/",
    "\\/evil.example",
    "/\\/evil.example",
    "http:evil.example", // scheme without slashes: parsed as absolute http://evil.example/
    "https:/\\evil.example",
    "HtTp://evil.example",
    "http://evil.example\\@localhost:3000/", // `\` ends the authority in special schemes
    "http://localhost.:3000/", // trailing dot is another origin (fail-closed)
    "http://LOCALHOST:3000@evil.example/",
    "ftp://localhost:3000/",
    "ws://localhost:3000/",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "http://evil.example/, /x", // two Location values joined: the browser sees one absolute URL
  ])("DEBT-446 blocked: %j", (l) => expectBlocked(l, site));

  it.each(["\u0000//evil.example/", "/\r\n/evil.example/", "/x\n//evil.example"])(
    "DEBT-446 %j cannot even be put in a Location (Headers refuses NUL/CR/LF), so it never reaches the wire",
    (l) => {
      expect(() => new Headers({ location: l })).toThrow(TypeError);
    },
  );

  it("DEBT-446 blocked: two Location headers, the off-origin one first", () =>
    expectBlocked(["http://evil.example/", "/x"], site));

  it("DEBT-446 two Location headers joined as one relative path stay relative (no authority)", async () => {
    // Headers joins with ", " and so does the wire: the browser resolves "/x, http://evil.example/" as a path.
    const { res, lines } = await run(["/x", "http://evil.example/"], site);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") ?? "", "http://localhost:3000").origin).toBe("http://localhost:3000");
    expect(lines).toEqual([]);
  });

  it.each([
    "/%2F%2Fevil.example", // encoded slashes stay in the path
    "/%5C%5Cevil.example",
    "/auth/login?returnTo=//evil.example",
    "/#//evil.example",
    "?next=//evil.example",
    "x/../..//y", // dot segments cannot climb into the authority
    "http://%6Cocalhost:3000/", // percent-encoded host decodes to the app host: same origin
    "http://localhost:3000\\@evil.example/", // `\` ends the authority: host is the app, `@evil...` is the path
  ])("DEBT-446 kept: %j", (l) => expectKept(l, site));
});

describe("run60-tester DEBT-446: blob: (senior nit, recorded)", () => {
  const site = { appUrl: "http://localhost:3000", issuer: "http://localhost:4000/realm" };
  it("DEBT-446 blob:<app origin> passes (origin of a blob URL is its inner origin; browsers refuse a redirect to blob:)", () =>
    expectKept("blob:http://localhost:3000/0b1c5e2a-0000-4000-8000-000000000000", site));
  it("DEBT-446 blob:<other origin> is blocked", () =>
    expectBlocked("blob:http://evil.example/0b1c5e2a-0000-4000-8000-000000000000", site));
});
