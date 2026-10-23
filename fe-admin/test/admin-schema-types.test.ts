// @vitest-environment node
// DEBT-290 (run 44): the zod response allowlists must match the BE view schemas in the OpenAPI
// snapshot. Type-level: a drift (new/renamed field, other enum or nullability) fails `typecheck`.
import { describe, expectTypeOf, it } from "vitest";
import type { components, operations } from "@/server/admin-api/schema";
import type {
  AdminClient,
  AdminConsent,
  AdminFamily,
  AdminResource,
  AdminUser,
  AuditEvent,
  AuditPage,
  ClientPage,
  ConsentPage,
  CredentialList,
  FamilyPage,
  IssuedSecret,
  ResourcePage,
  RotateKeyResult,
  SigningKey,
  SigningKeyList,
  UserPage,
} from "@/server/admin-api/schemas";
import { AUDIT_ACTIONS, AUDIT_RESULTS, ROTATION_MODES } from "@/features/admin-api/inputs";
import type {
  AuditListParams,
  CreateClientParams,
  CreateResourceParams,
  RotateKeyParams,
  UpdateClientParams,
  UpdateResourceParams,
  UserListParams,
} from "@/features/admin-api/inputs";

type S = components["schemas"];

describe("zod allowlists vs OpenAPI snapshot", () => {
  it("responses", () => {
    expectTypeOf<AdminClient>().toEqualTypeOf<S["AdminClientViewDto"]>();
    expectTypeOf<ClientPage>().toEqualTypeOf<S["ClientPageViewDto"]>();
    expectTypeOf<AdminResource>().toEqualTypeOf<S["AdminResourceViewDto"]>();
    expectTypeOf<ResourcePage>().toEqualTypeOf<S["ResourcePageViewDto"]>();
    expectTypeOf<CredentialList>().toEqualTypeOf<S["CredentialListViewDto"]>();
    expectTypeOf<IssuedSecret>().toEqualTypeOf<S["IssuedSecretViewDto"]>();
  });

  it("users, families, consents (run 47 Task 0)", () => {
    expectTypeOf<AdminUser>().toEqualTypeOf<S["AdminUserViewDto"]>();
    expectTypeOf<UserPage>().toEqualTypeOf<S["UserPageViewDto"]>();
    expectTypeOf<AdminFamily>().toEqualTypeOf<S["AdminFamilyViewDto"]>();
    expectTypeOf<FamilyPage>().toEqualTypeOf<S["FamilyPageViewDto"]>();
    expectTypeOf<AdminConsent>().toEqualTypeOf<S["AdminConsentViewDto"]>();
    expectTypeOf<ConsentPage>().toEqualTypeOf<S["ConsentPageViewDto"]>();
    // The list filters are exactly the BE query parameters.
    expectTypeOf<UserListParams>().toEqualTypeOf<NonNullable<operations["AdminUsersController_list"]["parameters"]["query"]>>();
  });

  it("audit (run 48 F2)", () => {
    type Q = NonNullable<operations["AdminAuditController_list"]["parameters"]["query"]>;
    type View = S["AdminAuditEventViewDto"];
    // Both ways: an action added to or removed from the BE enum fails `typecheck`.
    expectTypeOf<(typeof AUDIT_ACTIONS)[number]>().toEqualTypeOf<NonNullable<Q["action"]>>();
    expectTypeOf<(typeof AUDIT_ACTIONS)[number]>().toEqualTypeOf<View["action"]>();
    expectTypeOf<(typeof AUDIT_RESULTS)[number]>().toEqualTypeOf<View["result"]>();
    // Same filter names as the BE query, each a valid value of it (`targetType` narrowed to the known ones).
    expectTypeOf<keyof AuditListParams>().toEqualTypeOf<keyof Q>();
    expectTypeOf<AuditListParams>().toExtend<Q>();
    // The response allowlist has exactly the view's keys (action/actorType kept as plain strings on purpose).
    expectTypeOf<keyof AuditEvent>().toEqualTypeOf<keyof View>();
    expectTypeOf<keyof AuditPage>().toEqualTypeOf<keyof S["AuditPageViewDto"]>();
  });

  it("signing keys (run 49 F2)", () => {
    type Key = S["AdminKeyViewDto"];
    type Rotated = S["RotateKeyResultViewDto"];
    // Both ways: a status or mode added to or removed from the BE enum fails `typecheck`.
    expectTypeOf<SigningKey["status"]>().toEqualTypeOf<Key["status"]>();
    expectTypeOf<(typeof ROTATION_MODES)[number]>().toEqualTypeOf<S["RotateKeyDto"]["mode"]>();
    expectTypeOf<RotateKeyResult["mode"]>().toEqualTypeOf<Rotated["mode"]>();
    expectTypeOf<RotateKeyParams>().toEqualTypeOf<S["RotateKeyDto"]>();
    // Exactly the view's keys (`alg` kept a plain string, `nextCursor` narrowed to the BE's constant null).
    expectTypeOf<keyof SigningKey>().toEqualTypeOf<keyof Key>();
    expectTypeOf<SigningKey>().toExtend<Omit<Key, "alg"> & { alg: string }>();
    expectTypeOf<keyof SigningKeyList>().toEqualTypeOf<keyof S["KeyListViewDto"]>();
    expectTypeOf<RotateKeyResult>().toEqualTypeOf<Rotated>();
  });

  it("request bodies", () => {
    expectTypeOf<CreateClientParams>().toEqualTypeOf<S["CreateClientDto"]>();
    expectTypeOf<UpdateClientParams["patch"]>().toEqualTypeOf<S["UpdateClientDto"]>();
    // The form always sends `scopes` (optional in the BE DTO): a valid body of it, not equal.
    expectTypeOf<CreateResourceParams>().toExtend<S["CreateResourceDto"]>();
    expectTypeOf<keyof CreateResourceParams>().toEqualTypeOf<keyof S["CreateResourceDto"]>();
    expectTypeOf<UpdateResourceParams["patch"]>().toEqualTypeOf<S["UpdateResourceDto"]>();
  });

  it("resource get / create / update responses (run 46 Task 0)", () => {
    type Json<O extends keyof operations, C extends number> = operations[O]["responses"] extends Record<
      C,
      { content: { "application/json": infer B } }
    >
      ? B
      : never;
    expectTypeOf<Json<"AdminResourcesController_get", 200>>().toEqualTypeOf<AdminResource>();
    expectTypeOf<Json<"AdminResourcesController_create", 201>>().toEqualTypeOf<AdminResource>();
    expectTypeOf<Json<"AdminResourcesController_update", 200>>().toEqualTypeOf<AdminResource>();
  });
});
