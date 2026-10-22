// URI cases shared by the schema test and the form component test (run 44 A6.1).
/** Shared table (also used by the form component test): value => expected problem (null = ok). */
export const REDIRECT_CASES: [string, RegExp | null][] = [
  ["https://app.example/cb", null],
  ["https://app.example/cb?x=1", null],
  ["http://localhost:8080/cb", null],
  ["https://*.example/cb", /wildcard/],
  ["https://app.example/*", /wildcard/],
  ["/relative/cb", /absolute/],
  ["app.example/cb", /absolute/],
  ["https://app.example/cb#frag", /fragment/],
  ["https://a;b.example/cb", /invalid character/],
  ["https://a,b.example/cb", /invalid character/],
  ["javascript:alert(1)", /https/],
  ["data:text/html,x", /https/],
  ["vbscript:x", /https/],
  ["file:///etc/passwd", /https/],
  ["ftp://app.example/cb", /https/],
  ["http://app.example/cb", /https/],
  ["http://127.0.0.1/cb", /https/],
  ["http://localhost.evil.example/cb", /https/],
  [`https://app.example/${"a".repeat(2048)}`, /2048/],
];

export const ORIGIN_CASES: [string, RegExp | null][] = [
  ["https://app.example", null],
  ["https://app.example:8443", null],
  ["http://localhost:5173", null],
  ["https://app.example/", /exact origin/],
  ["https://app.example/path", /exact origin/],
  ["https://app.example?x", /exact origin/],
  ["https://*.example", /wildcard/],
  ["http://app.example", /https/],
  ["javascript:alert(1)", /https/],
  ["app.example", /absolute/],
];
