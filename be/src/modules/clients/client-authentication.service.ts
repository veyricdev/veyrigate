import { Injectable } from '@nestjs/common';
import { ClientCredentialService } from './client-credential.service';
import { ClientService, type Client, type TokenEndpointAuthMethod } from './client.service';

/**
 * Domain error for a failed `/token` client authentication (B3.3). Deliberately NOT an
 * HttpException: the OAuth error code/response shape is the caller's decision (future `/token`
 * controller, B4) — this file only decides *whether* authentication succeeded, never the HTTP
 * representation, and the message never includes the submitted secret.
 */
export class InvalidClientError extends Error {
  constructor(message = 'Client authentication failed') {
    super(message);
    this.name = 'InvalidClientError';
  }
}

export interface ClientAuthenticationInput {
  clientId: string;
  method: TokenEndpointAuthMethod;
  /** Only present for `client_secret_basic`/`client_secret_post`. */
  secret?: string;
}

/**
 * Client authentication for `/token` (B3.3, spec §9.3, INV-21; tech-lead C3/C4).
 *
 * - `none` (public client): no secret is compared. PKCE enforcement itself happens in the
 *   `/token` flow (B4) — out of scope here, this only checks the client is registered as
 *   `none` and does not accept a secret in its place.
 * - `client_secret_basic` / `client_secret_post`: delegates the secret check to
 *   `ClientCredentialService.verifySecret`, which accepts any still-valid version (rotation
 *   overlap, B3.1/C2) and never short-circuits across versions.
 *
 * Timing/enumeration (C4): for `basic`/`post`, `ClientCredentialService.verifySecret` always
 * runs an Argon2 verify — a dummy hash when the client has no valid credential (unknown
 * `client_id`, or fully expired/revoked) — so "client does not exist", "wrong method", and
 * "wrong secret" all take the same DB-lookup-plus-Argon2-verify shape and cannot be
 * distinguished by response timing alone.
 */
@Injectable()
export class ClientAuthenticationService {
  constructor(
    private readonly clients: ClientService,
    private readonly credentials: ClientCredentialService,
  ) {}

  async authenticate(input: ClientAuthenticationInput): Promise<Client> {
    const client = await this.clients.findByClientId(input.clientId);

    if (input.method === 'none') {
      if (!client || client.tokenEndpointAuthMethod !== 'none') {
        throw new InvalidClientError();
      }
      return client;
    }

    // Always verify — even for an unknown client_id or a method mismatch — to equalise timing.
    const result = await this.credentials.verifySecret(input.clientId, input.secret ?? '');
    if (!client || client.tokenEndpointAuthMethod !== input.method || !result.valid) {
      throw new InvalidClientError();
    }
    return client;
  }
}
