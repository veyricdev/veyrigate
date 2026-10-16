import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';
import { mapDuplicate } from '../identity/identity.errors';
import type { TenantContext } from '../identity/tenant-context/tenant-context';
import { TenantScopedRepository } from '../identity/tenant-context/tenant-scoped.repository';
import { adminResourceIdentifier } from '../oauth/token/token.service';
import { ResourceService } from '../resources/resource.service';
import { validateRedirectUriFormat, validateRedirectUriList } from './redirect-uri.validator';

export type ClientType = 'public' | 'confidential';
export type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';
export type GrantType = 'authorization_code' | 'refresh_token';

export interface Client {
  clientId: string;
  clientType: ClientType;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  grantTypes: GrantType[];
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  /** OIDC front-channel logout endpoint (B4.7); absent when the RP opts out. */
  frontchannelLogoutUri?: string;
  allowedCorsOrigins: string[];
  allowedResources: string[];
  scopes: string[];
  tenantId: string;
  /** Admin disable (B6.3a); null/absent = enabled. */
  disabledAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateClientInput {
  clientId: string;
  clientType: ClientType;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  grantTypes?: GrantType[];
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  frontchannelLogoutUri?: string;
  allowedCorsOrigins?: string[];
  allowedResources?: string[];
  scopes?: string[];
  tenantId: string;
}

/** Admin create (B6.3a): `clientId` is server-generated, `tenantId` comes from the token only. */
export type AdminCreateClientInput = Omit<CreateClientInput, 'clientId' | 'tenantId'>;

/** Admin PATCH (B6.3a): arrays replace wholesale; `frontchannelLogoutUri: null` removes it. */
export interface AdminClientPatch {
  grantTypes?: GrantType[];
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  frontchannelLogoutUri?: string | null;
  allowedCorsOrigins?: string[];
  allowedResources?: string[];
  scopes?: string[];
  disabled?: boolean;
}

/** The admin performing a write (roles decide who may grant the `admin` resource). */
export interface ClientWriteActor {
  roles: readonly string[];
}

/** A client configuration value is invalid (=> 400 at the admin API). */
export class InvalidClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidClientConfigError';
  }
}

/** The actor may not configure this (=> 403 at the admin API), e.g. grant the `admin` resource. */
export class ForbiddenClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenClientConfigError';
  }
}

/**
 * A CORS allowlist entry must be exactly a serialized origin (B6.3a): what a browser sends in
 * `Origin` — scheme + host + optional port, no path/query/fragment/trailing slash/wildcard — and
 * `https`, except `http://localhost` outside production (same rule as redirect URIs, INV-4).
 */
export function validateCorsOrigin(origin: string, opts: { allowHttpLocalhost: boolean }): void {
  let parsed: URL | undefined;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = undefined;
  }
  if (!parsed || origin.includes('*') || parsed.origin !== origin) {
    throw new InvalidClientConfigError(
      `allowedCorsOrigins entry must be an exact origin: ${origin}`,
    );
  }
  const isDevLocalhost =
    opts.allowHttpLocalhost && parsed.protocol === 'http:' && parsed.hostname === 'localhost';
  if (parsed.protocol !== 'https:' && !isDevLocalhost) {
    throw new InvalidClientConfigError(
      `allowedCorsOrigins entry must use https (http://localhost only outside production): ${origin}`,
    );
  }
}

/**
 * Clients (global collection keyed by `clientId`, spec §9.3/§9.10; tenant ownership is carried
 * in `tenantId`). The OAuth endpoints use `findByClientId`; the admin API (B6.3a) uses the
 * `*ForTenant` methods, which always put the token's `tenantId` into the query (INV-24).
 *
 * `redirectUris`/`postLogoutRedirectUris` are validated for *format* at write time (B3.1,
 * tech-lead C1): `https` only, except `http://localhost` when `NODE_ENV !== 'production'`.
 * Wildcard/fragment are always rejected regardless of environment.
 */
@Injectable()
export class ClientService {
  private readonly allowHttpLocalhost: boolean;
  private readonly issuer: string | undefined;
  private readonly repo: TenantScopedRepository<Client>;

  constructor(
    @InjectModel('Client') private readonly clients: Model<Client>,
    config: ConfigService,
    // Only the admin writes need it (resource existence + `admin` resource rule) and they fail
    // closed without it. Optional so the OAuth-only wirings (`new ClientService(model, cfg)`) stay.
    @Optional() private readonly resources?: ResourceService,
  ) {
    const app = config.getOrThrow<AppConfig>('app');
    this.allowHttpLocalhost = app.nodeEnv !== 'production';
    this.issuer = app.issuer;
    this.repo = new TenantScopedRepository(clients);
  }

  async create(input: CreateClientInput): Promise<Client> {
    if (!isValidAuthMethodFor(input.clientType, input.tokenEndpointAuthMethod)) {
      throw new InvalidClientConfigError(
        'tokenEndpointAuthMethod must be none for a public client and client_secret_basic or client_secret_post for a confidential client',
      );
    }
    this.validateConfig(input);
    const doc = await mapDuplicate('Client', () =>
      this.clients.create({
        clientId: input.clientId,
        clientType: input.clientType,
        tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
        ...(input.grantTypes ? { grantTypes: input.grantTypes } : {}),
        redirectUris: input.redirectUris ?? [],
        postLogoutRedirectUris: input.postLogoutRedirectUris ?? [],
        ...(input.frontchannelLogoutUri !== undefined
          ? { frontchannelLogoutUri: input.frontchannelLogoutUri }
          : {}),
        allowedCorsOrigins: input.allowedCorsOrigins ?? [],
        allowedResources: input.allowedResources ?? [],
        scopes: input.scopes ?? [],
        tenantId: input.tenantId,
      }),
    );
    return doc.toObject();
  }

  /**
   * The single gate every OAuth/OIDC path uses (`/authorize`, `/token`, `/introspect`, access-token
   * liveness, logout): a disabled client (B6.3a) is "unknown" everywhere at once. `disabledAt: null`
   * also matches documents written before the field existed.
   */
  async findByClientId(clientId: string): Promise<Client | null> {
    const client = await this.clients.findOne({ clientId, disabledAt: null }).lean<Client>().exec();
    if (!client) return null;
    // `.lean()` bypasses Mongoose defaults, so a document written before `grantTypes` existed
    // reads back without the field — normalise here so every caller sees a concrete array and
    // `/token` cannot 500 on an older client (tech-lead fold, Task 1).
    return { ...client, grantTypes: client.grantTypes ?? ['authorization_code'] };
  }

  /** Admin create (B6.3a, D-27.b): server-generated `clientId`; never issues a secret (Q-27.3). */
  async createForTenant(
    ctx: TenantContext,
    input: AdminCreateClientInput,
    actor: ClientWriteActor,
  ): Promise<Client> {
    await this.assertAllowedResources(input.allowedResources ?? [], actor);
    return this.create({ ...input, clientId: randomUUID(), tenantId: ctx.tenantId });
  }

  /** Admin read in the token's tenant (disabled clients included). */
  getForTenant(ctx: TenantContext, clientId: string): Promise<Client | null> {
    return this.repo.findOne(ctx, { clientId });
  }

  /**
   * The subset of `clientIds` that belongs to the token's tenant (disabled included): tenant in
   * the query itself (INV-24). Scopes the tenant-less collections (RefreshToken, Consent).
   */
  async tenantClientIds(ctx: TenantContext, clientIds: string[]): Promise<string[]> {
    if (clientIds.length === 0) return [];
    const rows = await this.repo.find(
      ctx,
      { clientId: { $in: clientIds } },
      { projection: { clientId: 1 } },
    );
    return rows.map((c) => c.clientId);
  }

  /** Admin list in the token's tenant, ordered by `clientId`, strictly after the cursor. */
  listForTenant(ctx: TenantContext, after: string | undefined, limit: number): Promise<Client[]> {
    return this.repo.find(ctx, after === undefined ? {} : { clientId: { $gt: after } }, {
      sort: { clientId: 1 },
      limit,
    });
  }

  /**
   * Admin PATCH in the token's tenant (B6.3a). Validates exactly like `create`, applies the update
   * atomically and returns the document before AND after (for the audit diff), or null when the
   * client is not in this tenant.
   */
  async updateForTenant(
    ctx: TenantContext,
    clientId: string,
    patch: AdminClientPatch,
    actor: ClientWriteActor,
  ): Promise<{ before: Client; after: Client } | null> {
    this.validateConfig(patch);
    if (patch.allowedResources !== undefined) {
      await this.assertAllowedResources(patch.allowedResources, actor);
    }
    // A client that can already obtain `aud=admin` tokens is super_admin-only for EVERY write
    // (else tenant_admin could repoint its redirect URIs / take its secret => escalation). Checked
    // inside the update filter so a concurrent grant of `admin` cannot slip between check and write.
    const adminIds = isSuperAdmin(actor) ? [] : await this.adminResourceIds();
    const set: Record<string, unknown> = {};
    for (const key of PATCHABLE_ARRAYS) {
      if (patch[key] !== undefined) set[key] = patch[key];
    }
    if (typeof patch.frontchannelLogoutUri === 'string') {
      set.frontchannelLogoutUri = patch.frontchannelLogoutUri;
    }
    if (patch.disabled !== undefined) set.disabledAt = patch.disabled ? new Date() : null;
    const unsetFrontchannel = patch.frontchannelLogoutUri === null;

    const before = await this.repo.findOneAndUpdate(
      ctx,
      adminIds.length ? { clientId, allowedResources: { $nin: adminIds } } : { clientId },
      {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(unsetFrontchannel ? { $unset: { frontchannelLogoutUri: 1 } } : {}),
      },
    );
    if (!before) {
      // Same-tenant re-read only: a client of another tenant stays an opaque 404.
      if (adminIds.length && (await this.getForTenant(ctx, clientId))) {
        throw new ForbiddenClientConfigError('only super_admin may modify an admin client');
      }
      return null;
    }
    const after = { ...before, ...set } as Client;
    if (unsetFrontchannel) delete after.frontchannelLogoutUri;
    return { before, after };
  }

  /** Non-atomic variant for the secret endpoints: refuse when `client` can obtain admin tokens. */
  async assertMayModify(client: Client, actor: ClientWriteActor): Promise<void> {
    if (isSuperAdmin(actor)) return;
    const adminIds = await this.adminResourceIds();
    if ((client.allowedResources ?? []).some((id) => adminIds.includes(id))) {
      throw new ForbiddenClientConfigError('only super_admin may modify an admin client');
    }
  }

  /** `resourceId` of the admin API resource (none registered => []). Fails closed without wiring. */
  private async adminResourceIds(): Promise<string[]> {
    if (!this.resources || !this.issuer) {
      throw new Error(
        'ClientService: ResourceService and app.issuer are required for admin writes',
      );
    }
    const admin = await this.resources.findByIdentifier(adminResourceIdentifier(this.issuer));
    return admin ? [admin.resourceId] : [];
  }

  /** Format rules shared by create + update (only the fields present are checked). */
  private validateConfig(input: {
    redirectUris?: readonly string[];
    postLogoutRedirectUris?: readonly string[];
    frontchannelLogoutUri?: string | null;
    allowedCorsOrigins?: readonly string[];
  }): void {
    const opts = { allowHttpLocalhost: this.allowHttpLocalhost };
    validateRedirectUriList(input.redirectUris ?? [], opts);
    validateRedirectUriList(input.postLogoutRedirectUris ?? [], opts);
    // Front-channel logout URI follows the same INV-4 format rule as redirect URIs (B4.7).
    if (typeof input.frontchannelLogoutUri === 'string') {
      validateRedirectUriFormat(input.frontchannelLogoutUri, opts);
    }
    for (const origin of input.allowedCorsOrigins ?? []) validateCorsOrigin(origin, opts);
  }

  /**
   * Admin writes only (B6.3a): every `resourceId` must exist, and only a `super_admin` may allow
   * the `admin` resource — otherwise a tenant_admin could build a client that obtains `aud=admin`
   * tokens of any other admin of the tenant (confused deputy / escalation). Fails closed (5xx)
   * when the wiring lacks what the rule needs.
   */
  private async assertAllowedResources(
    resourceIds: readonly string[],
    actor: ClientWriteActor,
  ): Promise<void> {
    if (resourceIds.length === 0) return;
    if (!this.resources || !this.issuer) {
      throw new Error(
        'ClientService: ResourceService and app.issuer are required for admin writes',
      );
    }
    const adminIdentifier = adminResourceIdentifier(this.issuer);
    const found = await this.resources.findByResourceIds(resourceIds);
    const known = new Set(found.map((r) => r.resourceId));
    const missing = resourceIds.find((id) => !known.has(id));
    if (missing !== undefined) {
      throw new InvalidClientConfigError(
        `allowedResources entry is not a known resource: ${missing}`,
      );
    }
    if (found.some((r) => r.identifier === adminIdentifier) && !isSuperAdmin(actor)) {
      throw new ForbiddenClientConfigError('only super_admin may allow the admin resource');
    }
  }
}

const PATCHABLE_ARRAYS = [
  'grantTypes',
  'redirectUris',
  'postLogoutRedirectUris',
  'allowedCorsOrigins',
  'allowedResources',
  'scopes',
] as const;

function isSuperAdmin(actor: ClientWriteActor): boolean {
  return actor.roles.includes('super_admin');
}

/** `public` <=> `none`; `confidential` <=> a secret method (a public client never "has" a secret). */
function isValidAuthMethodFor(type: ClientType, method: TokenEndpointAuthMethod): boolean {
  return type === 'public'
    ? method === 'none'
    : method === 'client_secret_basic' || method === 'client_secret_post';
}
