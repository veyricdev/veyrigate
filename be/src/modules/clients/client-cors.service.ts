import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { Client } from './client.service';

/**
 * Dynamic CORS origin resolution for the OAuth endpoints (B3.4, spec §9.7, D8).
 *
 * Deliberately NOT a global static CORS allowlist and NOT an HTTP hook: the allowlist is
 * per-client and read from the DB (`Client.allowedCorsOrigins`, never `redirect_uris`), so the
 * endpoints that need it (`/token`, `/userinfo` — B4; `/jwks.json`, discovery — B4/B6) call the
 * matching method *after* they know their client context, then set the CORS headers themselves.
 * This service only answers "is this origin allowed?"; it never touches the HTTP response.
 *
 * Endpoint → method mapping (tech-lead C5):
 * - `/token`                     → `isOriginAllowedForClient` (client_id from body/Basic auth).
 * - `/userinfo`                  → `isOriginAllowedForClient` (client_id from verified token claim).
 * - `/jwks.json`, discovery      → `isOriginRegisteredForAnyClient` (no client context: union of
 *                                  every registered `allowedCorsOrigins`).
 * - preflight (`OPTIONS`)        → `isOriginRegisteredForAnyClient` (no client context yet).
 *
 * Origins are compared as exact strings (scheme + host + optional port), matching what a browser
 * sends in the `Origin` header — no normalisation, no wildcard.
 */
@Injectable()
export class ClientCorsService {
  constructor(@InjectModel('Client') private readonly clients: Model<Client>) {}

  /** True if `origin` is in the given client's `allowedCorsOrigins`. Unknown client → false. */
  async isOriginAllowedForClient(clientId: string, origin: string): Promise<boolean> {
    if (!origin) return false;
    const client = await this.clients
      .findOne({ clientId }, { allowedCorsOrigins: 1 })
      .lean<Pick<Client, 'allowedCorsOrigins'>>()
      .exec();
    return client?.allowedCorsOrigins?.includes(origin) ?? false;
  }

  /**
   * True if `origin` is registered in *any* client's `allowedCorsOrigins` (union allowlist).
   * Used where there is no client context: `/jwks.json`, discovery, and `OPTIONS` preflight.
   */
  async isOriginRegisteredForAnyClient(origin: string): Promise<boolean> {
    if (!origin) return false;
    const match = await this.clients
      .findOne({ allowedCorsOrigins: origin }, { _id: 1 })
      .lean()
      .exec();
    return match !== null;
  }
}
