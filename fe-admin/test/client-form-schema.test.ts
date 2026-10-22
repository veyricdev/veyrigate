// @vitest-environment node
// Client form rules (run 44 A6.1): a mirror of the BE URI rules, plus the request bodies built
// from the form (create body; PATCH with only the changed fields, never an immutable one).
import { describe, expect, it } from "vitest";
import {
  ClientFieldsSchema,
  EMPTY_VALUES,
  changedValues,
  hasHttpLocalhost,
  toCreateBody,
  toPatch,
  uriProblem,
  valuesFrom,
} from "@/features/clients/client-form-schema";
import { ClientPatchSchema, CreateClientInput } from "@/features/admin-api/inputs";
import type { AdminClient } from "@/server/admin-api/schemas";
import { ORIGIN_CASES, REDIRECT_CASES } from "./support/uri-cases";

describe("uriProblem (mirror of the BE rules)", () => {
  it.each(REDIRECT_CASES)("redirect %j", (value, expected) => {
    const problem = uriProblem(value, "redirect");
    if (expected) expect(problem).toMatch(expected);
    else expect(problem).toBeNull();
  });
  it.each(ORIGIN_CASES)("origin %j", (value, expected) => {
    const problem = uriProblem(value, "origin");
    if (expected) expect(problem).toMatch(expected);
    else expect(problem).toBeNull();
  });
  it("http://localhost is flagged as a (non-blocking) warning", () => {
    expect(hasHttpLocalhost("https://a.example/cb\nhttp://localhost:3000/cb")).toBe(true);
    expect(hasHttpLocalhost("https://localhost/cb\nhttp://127.0.0.1/cb")).toBe(false);
  });
});

const fieldErrors = (values: Partial<typeof EMPTY_VALUES>) => {
  const res = ClientFieldsSchema.safeParse({ ...EMPTY_VALUES, ...values });
  const out: Record<string, { message: string }[]> = {};
  if (!res.success) for (const i of res.error.issues) (out[String(i.path[0])] ??= []).push(i);
  return out;
};

describe("form schema", () => {
  it("one URI per line: trimmed, blank lines dropped (never sent), errors carry the textarea line", () => {
    const res = ClientFieldsSchema.parse({ ...EMPTY_VALUES, redirectUris: "  https://a.example/cb \n\n\nhttps://b.example/cb\n" });
    expect(res.redirectUris).toEqual(["https://a.example/cb", "https://b.example/cb"]);
    const errors = fieldErrors({ redirectUris: "https://a.example/cb\n\nhttps://*.example/cb" });
    expect(errors.redirectUris!.map((i) => i.message)).toEqual(["Line 3: must not contain a wildcard (*)"]);
  });

  it("duplicates and > 20 entries are errors", () => {
    expect(fieldErrors({ allowedCorsOrigins: "https://a.example\nhttps://a.example" }).allowedCorsOrigins![0]!.message).toBe(
      "Line 2: is listed twice",
    );
    const many = Array.from({ length: 21 }, (_, i) => `https://a.example/cb${i}`).join("\n");
    expect(fieldErrors({ postLogoutRedirectUris: many }).postLogoutRedirectUris![0]!.message).toBe("At most 20 entries");
  });

  it("front-channel URI: empty => null, else the redirect rules", () => {
    expect(ClientFieldsSchema.parse({ ...EMPTY_VALUES, frontchannelLogoutUri: "  " }).frontchannelLogoutUri).toBeNull();
    expect(fieldErrors({ frontchannelLogoutUri: "javascript:alert(1)" }).frontchannelLogoutUri![0]!.message).toMatch(/https/);
  });

  it("scopes: whitespace-separated tokens, no duplicates, ≤ 20", () => {
    expect(ClientFieldsSchema.parse({ ...EMPTY_VALUES, scopes: " openid  profile\nemail " }).scopes).toEqual([
      "openid",
      "profile",
      "email",
    ]);
    expect(fieldErrors({ scopes: "openid openid" }).scopes![0]!.message).toMatch(/twice/);
    expect(fieldErrors({ scopes: Array.from({ length: 21 }, (_, i) => `s${i}`).join(" ") }).scopes).toBeDefined();
  });
});

const CLIENT: AdminClient = {
  clientId: "app-1",
  tenantId: "t1",
  clientType: "confidential",
  tokenEndpointAuthMethod: "client_secret_basic",
  grantTypes: ["authorization_code", "refresh_token"],
  redirectUris: ["https://app.example/cb"],
  postLogoutRedirectUris: [],
  frontchannelLogoutUri: "https://app.example/fc",
  allowedCorsOrigins: [],
  allowedResources: ["demo"],
  scopes: ["openid", "profile"],
  disabled: false,
  disabledAt: null,
  createdAt: null,
  updatedAt: null,
};
const parse = (values: typeof EMPTY_VALUES) => ClientFieldsSchema.parse(values);
/** PATCH as the edit page builds it: changed vs the form's base, values from the parsed fields. */
const patchOf = (values: typeof EMPTY_VALUES, base: typeof EMPTY_VALUES) =>
  toPatch(parse(values), changedValues(values, base));

describe("request bodies", () => {
  it("unchanged form => empty PATCH", () => {
    expect(patchOf(valuesFrom(CLIENT), valuesFrom(CLIENT))).toEqual({});
  });

  it("PATCH holds only the changed fields; never an immutable field or `disabled`; strict schema accepts it", () => {
    const values = { ...valuesFrom(CLIENT), redirectUris: "https://app.example/cb\nhttps://app.example/cb2", frontchannelLogoutUri: "" };
    const patch = patchOf(values, valuesFrom(CLIENT));
    expect(patch).toEqual({ redirectUris: ["https://app.example/cb", "https://app.example/cb2"], frontchannelLogoutUri: null });
    for (const key of ["clientId", "clientType", "tokenEndpointAuthMethod", "tenantId", "disabled"]) {
      expect(patch).not.toHaveProperty(key);
    }
    expect(ClientPatchSchema.safeParse(patch).success).toBe(true);
  });

  it("the strict PATCH schema refuses an immutable field (defence in depth)", () => {
    for (const key of ["clientId", "clientType", "tokenEndpointAuthMethod", "tenantId"]) {
      expect(ClientPatchSchema.safeParse({ [key]: "x" }).success).toBe(false);
    }
  });

  it("diff is against the base the form was loaded from, never a newer server copy (no lost update)", () => {
    // Loaded v1, edited the scopes; meanwhile someone else removed a redirect URI (v2).
    const base = valuesFrom({ ...CLIENT, redirectUris: ["https://app.example/cb", "https://leaked.example/cb"] });
    const values = { ...base, scopes: "openid profile email" };
    expect(patchOf(values, base)).toEqual({ scopes: ["openid", "profile", "email"] });
    expect(changedValues(values, base)).toEqual({ scopes: "openid profile email" });
  });

  it("create body: type + method + lists; an empty front-channel URI is omitted", () => {
    const body = toCreateBody("public", "none", parse({ ...EMPTY_VALUES, redirectUris: "http://localhost:3000/cb" }));
    expect(body).toEqual({
      clientType: "public",
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
      redirectUris: ["http://localhost:3000/cb"],
      postLogoutRedirectUris: [],
      allowedCorsOrigins: [],
      allowedResources: [],
      scopes: [],
    });
    expect(CreateClientInput.safeParse(body).success).toBe(true);
  });
});
