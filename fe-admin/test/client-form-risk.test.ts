// @vitest-environment node
// Tester run 44 (A6.1): risk matrix for the client form rules. The FE mirror must never accept a
// value the BE refuses nor refuse one it accepts (except duplicates): parity is checked against the
// real BE validator on tricky inputs (encoded/injection payloads, IDN, CR/LF/TAB, userinfo, case).
import { describe, expect, it } from "vitest";
import { ClientFieldsSchema, EMPTY_VALUES, uriProblem } from "@/features/clients/client-form-schema";
import { validateRedirectUriFormat } from "../../be/src/modules/clients/redirect-uri.validator";

const beAccepts = (uri: string) => {
  try {
    validateRedirectUriFormat(uri, { allowHttpLocalhost: true });
    return true;
  } catch {
    return false;
  }
};

const REDIRECT_PARITY = [
  "https://app.example/cb",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "java\tscript:alert(1)",
  "javascript://app.example/%0aalert(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:,x",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "blob:https://app.example/uuid",
  "http://evil.example/cb",
  "http://127.0.0.1/cb",
  "http://[::1]/cb",
  "http://localhost.evil.example/cb",
  "http://LOCALHOST:3000/cb",
  "http://localhost./cb",
  "https://*.example/cb",
  "https://app.example/%2A",
  "https://app.example/cb#",
  "https://app.example/cb#x",
  "https://app.example/cb?x=1#y",
  "https://bücher.example/cb",
  "https://xn--bcher-kva.example/cb",
  "https://аpple.example/cb", // Cyrillic "а" (homograph): punycoded, accepted by both
  "https://user:pw@app.example/cb",
  "https://evil.example\\@app.example/cb",
  "https:app.example/cb",
  "https:/\\app.example/cb",
  "HTTPS://APP.EXAMPLE/CB",
  "https://app.example/c b",
  "https://a%20b.example/cb",
  "https://a%3Bb.example/cb",
  "https://a;b.example/cb",
  "https://app.example:99999/cb",
  "https://app.example/cb\r\nSet-Cookie: x=1",
  "https://app.exa\tmple/cb",
  "https://app.exa\rmple/cb",
  "https://app.example/<script>alert(1)</script>",
  "",
  " ",
];

describe("redirect URI: FE mirror == BE validator (allowHttpLocalhost = true, i.e. non-production)", () => {
  it.each(REDIRECT_PARITY.map((v) => [JSON.stringify(v), v]))("%s", (_label, value) => {
    expect(uriProblem(value, "redirect") === null).toBe(beAccepts(value));
  });
});

describe("CORS origin edge cases (BE: new URL(v).origin === v, https or http://localhost)", () => {
  it.each([
    ["https://app.example", null],
    ["https://app.example:443", /exact origin/], // default port is dropped by URL.origin
    ["https://bücher.example", /exact origin/], // origin is punycoded
    ["https://xn--bcher-kva.example", null],
    ["http://LOCALHOST:5173", /exact origin/],
    ["https://APP.example", /exact origin/],
    ["https://app.example/cb", /exact origin/],
    ["https://app.example#x", /exact origin/],
    ["https://user@app.example", /exact origin/],
    ["null", /absolute/],
    ["http://evil.example", /https/],
    ["data:text/plain,x", /https/],
    ["https://*.example", /wildcard/],
  ] as const)("%j", (value, expected) => {
    const problem = uriProblem(value, "origin");
    if (expected) expect(problem).toMatch(expected);
    else expect(problem).toBeNull();
  });
});

describe("textarea parsing", () => {
  it("CRLF line endings and surrounding whitespace never reach the request", () => {
    const out = ClientFieldsSchema.parse({
      ...EMPTY_VALUES,
      redirectUris: "https://a.example/cb\r\n\t https://b.example/cb \r\n\r\n",
      allowedCorsOrigins: "https://a.example\r\n",
    });
    expect(out.redirectUris).toEqual(["https://a.example/cb", "https://b.example/cb"]);
    expect(out.allowedCorsOrigins).toEqual(["https://a.example"]);
    for (const uri of [...out.redirectUris, ...out.allowedCorsOrigins]) expect(uri).not.toMatch(/\s/);
  });

  it("a whitespace-only textarea means an empty list; an empty scopes field means none", () => {
    const out = ClientFieldsSchema.parse({ ...EMPTY_VALUES, redirectUris: " \n\t\n", scopes: "   " });
    expect(out.redirectUris).toEqual([]);
    expect(out.scopes).toEqual([]);
  });

  it("every error of a multi-line field names its own line", () => {
    const res = ClientFieldsSchema.safeParse({
      ...EMPTY_VALUES,
      redirectUris: "https://ok.example/cb\njavascript:alert(1)\nhttp://evil.example/cb\nhttps://ok.example/cb#f",
    });
    expect(res.success).toBe(false);
    const messages = res.error!.issues.filter((i) => i.path[0] === "redirectUris").map((i) => i.message);
    expect(messages).toEqual([
      expect.stringMatching(/^Line 2: .*https/),
      expect.stringMatching(/^Line 3: .*localhost/),
      expect.stringMatching(/^Line 4: .*fragment/),
    ]);
  });
});
