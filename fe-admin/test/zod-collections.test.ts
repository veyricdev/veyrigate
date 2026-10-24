// @vitest-environment node
// Tester (run 51 retry, zod 4.6.5 -> 4.6.6, GHSA-mrhx-c7xc-m3w5): the BFF input schemas built on
// `@/lib/zod` (jitless) still enforce collection limits after the bump, and an oversized array is
// refused with ONE `too_big` issue instead of one issue per element (the memory-exhaustion vector).
import { describe, expect, it } from "vitest";
import { ClientPatchSchema, CreateClientInput, UpdateClientInput } from "@/features/admin-api/inputs";

const uris = (n: number) => Array.from({ length: n }, (_, i) => `https://a.example/${i}`);

describe("BFF client inputs after the zod bump", () => {
  it.each(["redirectUris", "postLogoutRedirectUris", "allowedCorsOrigins", "allowedResources", "scopes"])(
    "%s: 20 items pass, 21 items refused with too_big",
    (field) => {
      expect(ClientPatchSchema.safeParse({ [field]: uris(20) }).success).toBe(true);
      const r = ClientPatchSchema.safeParse({ [field]: uris(21) });
      expect(r.success).toBe(false);
      expect(r.error?.issues).toEqual([expect.objectContaining({ code: "too_big", maximum: 20, path: [field] })]);
    },
  );

  it("grantTypes: 21 items refused even when every item is a valid enum value", () => {
    const r = ClientPatchSchema.safeParse({ grantTypes: Array(21).fill("authorization_code") });
    expect(r.success).toBe(false);
  });

  it("200k invalid items: one too_big issue, items are not validated one by one", () => {
    const r = UpdateClientInput.safeParse({ clientId: "app-1", patch: { redirectUris: Array(200_000).fill(1) } });
    expect(r.success).toBe(false);
    expect(r.error?.issues).toHaveLength(1);
    expect(r.error?.issues[0]).toMatchObject({ code: "too_big", path: ["patch", "redirectUris"] });
  });

  it("create input: still strict (unknown key refused) and a valid body passes", () => {
    const ok = { clientType: "public", tokenEndpointAuthMethod: "none", redirectUris: uris(1) };
    expect(CreateClientInput.safeParse(ok).success).toBe(true);
    expect(CreateClientInput.safeParse({ ...ok, clientSecret: "s" }).success).toBe(false);
    expect(CreateClientInput.safeParse({ ...ok, redirectUris: [1] }).success).toBe(false);
  });
});
