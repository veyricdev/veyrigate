// @vitest-environment node
// Run 82 T1-FE (DEBT-538): every scope token the form or a server fn sends follows RFC 6749 §3.3
// `scope-token = 1*( %x21 / %x23-5B / %x5D-7E )`, the BE `SCOPE_TOKEN`. The error is fixed text
// (never the token). `expectedScopes` keeps the old loose rule: it only names what is stored, so a
// resource holding a legacy token can still be fixed.
import { describe, expect, it } from "vitest";
import { ClientFieldsSchema, EMPTY_VALUES } from "@/features/clients/client-form-schema";
import { EditResourceSchema, NewResourceSchema } from "@/features/resources/resource-form-schema";
import {
  ClientPatchSchema,
  CreateClientInput,
  CreateResourceInput,
  SCOPE_TOKEN_MESSAGE,
  UpdateResourceInput,
} from "@/features/admin-api/inputs";

/** Refused by the grammar, and never split by the form's `\s+` (one token in the textarea). */
const BAD = [
  ["ZWSP", "zw​"],
  ["bidi override", "a‮b"],
  ["soft hyphen", "a­b"],
  ["double quote", 'a"b'],
  ["backslash", "a\\b"],
  ["DEL", "a\u007fb"],
  ["non-ASCII letter", "café"],
  ["emoji", "\u{1F600}"],
] as const;
const GOOD = ["!#$%&'()*+,-./:;<=>?@[]^_`{|}~", "admin.read", "urn:x:y/z", "openid"];

const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.message);

describe("forms: a scope outside the grammar is a field error with a fixed message", () => {
  it.each(BAD)("%s", (_, token) => {
    const text = `ok ${token}`;
    for (const r of [
      EditResourceSchema.safeParse({ scopes: text }),
      NewResourceSchema.safeParse({ resourceId: "demo", identifier: "https://a/", scopes: text }),
      ClientFieldsSchema.safeParse({ ...EMPTY_VALUES, scopes: text }),
    ]) {
      expect(messages(r)).toEqual([SCOPE_TOKEN_MESSAGE]);
      expect(r.error!.issues[0]!.path).toEqual(["scopes"]);
      expect(JSON.stringify(r.error!.issues)).not.toContain(token);
    }
  });

  it("the grammar edges are accepted", () => {
    const text = GOOD.join(" ");
    expect(EditResourceSchema.parse({ scopes: text }).scopes).toEqual(GOOD);
    expect(ClientFieldsSchema.parse({ ...EMPTY_VALUES, scopes: text }).scopes).toEqual(GOOD);
  });

  it("the message is fixed text", () => {
    expect(SCOPE_TOKEN_MESSAGE).toBe('Scopes may only use visible ASCII characters other than " and \\');
  });
});

describe("server fn inputs: same grammar for client and resource scopes", () => {
  it.each([...BAD, ["space", "a b"], ["tab", "a\tb"], ["empty", ""]] as const)("%s refused", (_, token) => {
    const scopes = ["ok", token];
    expect(UpdateResourceInput.safeParse({ resourceId: "a", patch: { scopes } }).success).toBe(false);
    expect(CreateResourceInput.safeParse({ resourceId: "a", identifier: "https://a/", scopes }).success).toBe(false);
    expect(ClientPatchSchema.safeParse({ scopes }).success).toBe(false);
    expect(
      CreateClientInput.safeParse({ clientType: "public", tokenEndpointAuthMethod: "none", scopes }).success,
    ).toBe(false);
  });

  it("the grammar edges are accepted", () => {
    expect(UpdateResourceInput.safeParse({ resourceId: "a", patch: { scopes: GOOD } }).success).toBe(true);
    expect(CreateResourceInput.safeParse({ resourceId: "a", identifier: "https://a/", scopes: GOOD }).success).toBe(true);
    expect(ClientPatchSchema.safeParse({ scopes: GOOD }).success).toBe(true);
  });

  it("expectedScopes keeps the loose stored rule: a legacy resource can be fixed", () => {
    for (const legacy of ["zw​", "a‮b", 'a"b', "café"]) {
      const patch = { scopes: ["ok"], expectedScopes: [legacy] };
      expect(UpdateResourceInput.safeParse({ resourceId: "a", patch }).success).toBe(true);
    }
    // Still bounded and whitespace-free (the BE `STORED_SCOPE_TOKEN`).
    expect(UpdateResourceInput.safeParse({ resourceId: "a", patch: { scopes: [], expectedScopes: ["a b"] } }).success).toBe(false);
    expect(UpdateResourceInput.safeParse({ resourceId: "a", patch: { scopes: [], expectedScopes: [""] } }).success).toBe(false);
  });
});
