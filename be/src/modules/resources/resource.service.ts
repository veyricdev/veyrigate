import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { mapDuplicate } from '../identity/identity.errors';
import { validateResourceFormat } from './resource.validator';

export interface Resource {
  resourceId: string;
  identifier: string;
  scopes: string[];
}

export interface CreateResourceInput {
  resourceId: string;
  identifier: string;
  scopes?: string[];
}

/**
 * Resources (global collection, spec §7/§10). `identifier` is the absolute URI clients present
 * as the `resource` parameter; `resourceId` is the stable id stored in `Client.allowedResources[]`.
 */
@Injectable()
export class ResourceService {
  constructor(@InjectModel('Resource') private readonly resources: Model<Resource>) {}

  async create(input: CreateResourceInput): Promise<Resource> {
    validateResourceFormat(input.identifier);
    const doc = await mapDuplicate('Resource', () =>
      this.resources.create({
        resourceId: input.resourceId,
        identifier: input.identifier,
        scopes: input.scopes ?? [],
      }),
    );
    return doc.toObject();
  }

  findByIdentifier(identifier: string): Promise<Resource | null> {
    return this.resources.findOne({ identifier }).lean<Resource>().exec();
  }

  /**
   * Map a set of `resourceId`s (as stored in `Client.allowedResources[]`) to the absolute
   * `identifier` URIs of the matching `Resource` documents. Used by the access-token liveness
   * gate, the refresh rotation filter and `/introspect` caller authorization to compare a token's
   * `aud`/`resource` (a URI) against a client's allowlist WITHOUT ever comparing the URI to a
   * `resourceId` directly (confused-deputy guard, spec §7).
   *
   * `resourceId` is NOT unique (DEBT-077), so every identifier whose `resourceId` is in the set is
   * returned — never any identifier outside the allowed `resourceId` set. An empty input returns
   * an empty array without a query. A Mongo failure propagates (the caller fails closed); it is
   * never swallowed into an empty result that would silently reject a legitimate token.
   */
  async identifiersFor(resourceIds: readonly string[]): Promise<string[]> {
    if (resourceIds.length === 0) return [];
    const docs = await this.resources
      .find({ resourceId: { $in: [...resourceIds] } }, { identifier: 1 })
      .lean<Pick<Resource, 'identifier'>[]>()
      .exec();
    return docs.map((d) => d.identifier);
  }

  /**
   * Resolve a `resource` URI against a client's `allowedResources[]` (tech-lead C3):
   * look up `Resource` by `identifier` (URI) to get its `resourceId`, then check that
   * `resourceId` — never the URI itself — against `allowedResourceIds`.
   *
   * Throws `InvalidResourceError` (via `validateResourceFormat`) when `resourceUri` is not an
   * absolute URI / has a fragment. Returns `null` when the URI is well-formed but either not a
   * registered `Resource` or not in `allowedResourceIds` (INV-14) — both are "reject", the
   * caller (future `/authorize`, B4) decides the exact OAuth error code.
   */
  async resolveForClient(
    allowedResourceIds: readonly string[],
    resourceUri: string,
  ): Promise<Resource | null> {
    validateResourceFormat(resourceUri);
    const resource = await this.findByIdentifier(resourceUri);
    if (!resource) return null;
    if (!allowedResourceIds.includes(resource.resourceId)) return null;
    return resource;
  }
}
