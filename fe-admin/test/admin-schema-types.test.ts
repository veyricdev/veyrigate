// @vitest-environment node
// DEBT-290 (run 44): the zod response allowlists must match the BE view schemas in the OpenAPI
// snapshot. Type-level: a drift (new/renamed field, other enum or nullability) fails `typecheck`.
import { describe, expectTypeOf, it } from "vitest";
import type { components } from "@/server/admin-api/schema";
import type {
  AdminClient,
  AdminResource,
  ClientPage,
  CredentialList,
  IssuedSecret,
  ResourcePage,
} from "@/server/admin-api/schemas";
import type { CreateClientParams, UpdateClientParams } from "@/features/admin-api/inputs";

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
  });
});
