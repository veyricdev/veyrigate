// @vitest-environment node
// DEBT-290 (run 44): the zod response allowlists must match the BE view schemas in the OpenAPI
// snapshot. Type-level: a drift (new/renamed field, other enum or nullability) fails `typecheck`.
import { describe, expectTypeOf, it } from "vitest";
import type { components, operations } from "@/server/admin-api/schema";
import type {
  AdminClient,
  AdminResource,
  ClientPage,
  CredentialList,
  IssuedSecret,
  ResourcePage,
} from "@/server/admin-api/schemas";
import type {
  CreateClientParams,
  CreateResourceParams,
  UpdateClientParams,
  UpdateResourceParams,
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
