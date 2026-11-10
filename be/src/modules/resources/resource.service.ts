import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { DuplicateError, mapDuplicate } from '../identity/identity.errors';
import { validateResourceFormat, validateResourceIdentifier } from './resource.validator';

/**
 * DEBT-323: `updateScopes` with `expectedScopes` found the resource, but its scopes are no longer
 * the ones the caller read. Nothing was written.
 */
export class ConcurrentResourceUpdateError extends Error {
  constructor() {
    super('The resource was changed since it was read.');
    this.name = 'ConcurrentResourceUpdateError';
  }
}

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
    validateResourceIdentifier(input.identifier);
    const doc = await mapDuplicate('Resource', () =>
      this.resources.create({
        resourceId: input.resourceId,
        identifier: input.identifier,
        scopes: input.scopes ?? [],
      }),
    );
    return doc.toObject();
  }

  /**
   * Admin create (B6.3a): `resourceId` is not unique-indexed (DEBT-077/127), so a duplicate is
   * refused by a pre-check (race accepted: super_admin only); `identifier` by its unique index.
   */
  async createUnique(input: CreateResourceInput): Promise<Resource> {
    validateResourceIdentifier(input.identifier);
    if (await this.resources.exists({ resourceId: input.resourceId })) {
      throw new DuplicateError('Resource');
    }
    return this.create(input);
  }

  /** Admin list (global, spec §10), ordered by the unique `identifier`, strictly after the cursor. */
  list(after: string | undefined, limit: number): Promise<Resource[]> {
    return this.resources
      .find(after === undefined ? {} : { identifier: { $gt: after } })
      .sort({ identifier: 1 })
      .limit(limit)
      .lean<Resource[]>()
      .exec();
  }

  findByResourceId(resourceId: string): Promise<Resource | null> {
    return this.resources.findOne({ resourceId }).lean<Resource>().exec();
  }

  /** Every resource whose `resourceId` is in the set (B6.3a: validate `Client.allowedResources`). */
  findByResourceIds(resourceIds: readonly string[]): Promise<Resource[]> {
    return this.resources
      .find({ resourceId: { $in: [...resourceIds] } })
      .lean<Resource[]>()
      .exec();
  }

  /**
   * Admin PATCH (B6.3a, Q-27.4): only `scopes` may change — `resourceId`/`identifier` are
   * immutable (changing `identifier` would kill every live token's `aud` at once). Returns the
   * before/after documents, or null when not found. `identifier` pins the exact document the
   * caller checked (`resourceId` is not unique, DEBT-077).
   * `expectedScopes` (DEBT-323): written only while the stored scopes equal it exactly (ordered;
   * `[]` also matches an absent field) — the condition is in the atomic filter. A mismatch on an
   * existing resource throws `ConcurrentResourceUpdateError`; absent => last write wins.
   */
  async updateScopes(
    resourceId: string,
    scopes: string[],
    identifier: string,
    expectedScopes?: string[],
  ): Promise<{ before: Resource; after: Resource } | null> {
    const expected =
      expectedScopes === undefined
        ? {}
        : expectedScopes.length === 0
          ? { $or: [{ scopes: { $size: 0 } }, { scopes: { $exists: false } }] }
          : { scopes: expectedScopes };
    const before = await this.resources
      .findOneAndUpdate(
        { resourceId, identifier, ...expected },
        { $set: { scopes } },
        { returnDocument: 'before' },
      )
      .lean<Resource>()
      .exec();
    if (before) return { before, after: { ...before, scopes } };
    if (expectedScopes !== undefined && (await this.resources.exists({ resourceId, identifier }))) {
      throw new ConcurrentResourceUpdateError();
    }
    return null;
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
