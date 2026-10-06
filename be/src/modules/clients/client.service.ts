import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { mapDuplicate } from '../identity/identity.errors';
import { validateRedirectUriList } from './redirect-uri.validator';

export type ClientType = 'public' | 'confidential';
export type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

export interface Client {
  clientId: string;
  clientType: ClientType;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  allowedCorsOrigins: string[];
  allowedResources: string[];
  scopes: string[];
  tenantId: string;
}

export interface CreateClientInput {
  clientId: string;
  clientType: ClientType;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  allowedCorsOrigins?: string[];
  allowedResources?: string[];
  scopes?: string[];
  tenantId: string;
}

/**
 * Clients (global collection keyed by `clientId`, spec §9.3/§9.10; tenant ownership is carried
 * in `tenantId` but cross-tenant isolation for admin reads/writes is enforced in B6, not here).
 *
 * `redirectUris`/`postLogoutRedirectUris` are validated for *format* at write time (B3.1,
 * tech-lead C1): `https` only, except `http://localhost` when `NODE_ENV !== 'production'`.
 * Wildcard/fragment are always rejected regardless of environment.
 */
@Injectable()
export class ClientService {
  private readonly allowHttpLocalhost: boolean;

  constructor(
    @InjectModel('Client') private readonly clients: Model<Client>,
    config: ConfigService,
  ) {
    this.allowHttpLocalhost = config.getOrThrow<AppConfig>('app').nodeEnv !== 'production';
  }

  async create(input: CreateClientInput): Promise<Client> {
    const redirectUris = input.redirectUris ?? [];
    const postLogoutRedirectUris = input.postLogoutRedirectUris ?? [];
    validateRedirectUriList(redirectUris, { allowHttpLocalhost: this.allowHttpLocalhost });
    validateRedirectUriList(postLogoutRedirectUris, {
      allowHttpLocalhost: this.allowHttpLocalhost,
    });

    const doc = await mapDuplicate('Client', () =>
      this.clients.create({
        clientId: input.clientId,
        clientType: input.clientType,
        tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
        redirectUris,
        postLogoutRedirectUris,
        allowedCorsOrigins: input.allowedCorsOrigins ?? [],
        allowedResources: input.allowedResources ?? [],
        scopes: input.scopes ?? [],
        tenantId: input.tenantId,
      }),
    );
    return doc.toObject();
  }

  findByClientId(clientId: string): Promise<Client | null> {
    return this.clients.findOne({ clientId }).lean<Client>().exec();
  }
}
