import { HttpStatus } from '@nestjs/common';
import type { HttpRequest } from '../../common/http/http.types';
import type { TokenEndpointAuthMethod } from './client.service';

/** Resolved client credentials from an RFC 6749 §2.3 request (Basic header or body fields). */
export interface ResolvedClientAuth {
  clientId: string;
  method: TokenEndpointAuthMethod;
  secret?: string;
}

/**
 * Raised when client-auth parsing fails BEFORE a secret is checked (malformed request or a
 * client_id that cannot be resolved). `status` lets the caller map to the right OAuth HTTP code:
 * 400 `invalid_request` (two auth methods / malformed) or 401 `invalid_client` (bad/absent id).
 * Deliberately not an HttpException so each endpoint owns its error-body shape.
 */
export class ClientAuthRequestError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'invalid_client',
    readonly status: number,
  ) {
    super(code);
    this.name = 'ClientAuthRequestError';
  }
}

/** The `Authorization: Basic …` header (first value) if present, else undefined. */
export function basicAuthHeader(req: HttpRequest): string | undefined {
  const raw = req.headers['authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header && /^Basic /i.test(header) ? header : undefined;
}

/** Decode an HTTP Basic header into client credentials (RFC 6749 §2.3.1). */
function parseBasic(header: string | undefined): { clientId: string; secret: string } | null {
  if (!header) {
    return null;
  }
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) {
    throw new ClientAuthRequestError('invalid_client', HttpStatus.UNAUTHORIZED);
  }
  // Credentials are form-urlencoded before base64 (RFC 6749 §2.3.1 Appendix B). A malformed
  // percent-encoding (e.g. `%ZZ`) throws URIError => treat as bad credentials.
  try {
    const clientId = decodeURIComponent(decoded.slice(0, sep));
    const secret = decodeURIComponent(decoded.slice(sep + 1));
    return { clientId, secret };
  } catch {
    throw new ClientAuthRequestError('invalid_client', HttpStatus.UNAUTHORIZED);
  }
}

/**
 * Decide the client authentication method (RFC 6749 §2.3) from a parsed form body + request, the
 * single place `/token`, `/revoke` and `/introspect` share: Basic header => client_secret_basic;
 * client_secret in body => client_secret_post; only client_id => none. Using more than one method
 * is invalid_request; a body client_id that disagrees with Basic, or a completely absent client_id,
 * is invalid_client. Throws `ClientAuthRequestError`; never reads or returns the secret in an error.
 */
export function resolveClientAuth(req: HttpRequest, body: Map<string, string>): ResolvedClientAuth {
  const basic = parseBasic(basicAuthHeader(req));
  const bodyClientId = body.get('client_id');
  const bodySecret = body.get('client_secret');

  if (basic && bodySecret !== undefined) {
    throw new ClientAuthRequestError('invalid_request', HttpStatus.BAD_REQUEST);
  }

  if (basic) {
    if (bodyClientId !== undefined && bodyClientId !== basic.clientId) {
      throw new ClientAuthRequestError('invalid_client', HttpStatus.UNAUTHORIZED);
    }
    return { clientId: basic.clientId, method: 'client_secret_basic', secret: basic.secret };
  }

  if (!bodyClientId) {
    throw new ClientAuthRequestError('invalid_client', HttpStatus.UNAUTHORIZED);
  }
  if (bodySecret !== undefined) {
    return { clientId: bodyClientId, method: 'client_secret_post', secret: bodySecret };
  }
  return { clientId: bodyClientId, method: 'none' };
}
