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
