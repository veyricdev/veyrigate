import { Controller, HttpStatus, Logger, Post, Req, Res } from '@nestjs/common';
import type { HttpRequest } from '../../../common/http/http.types';
import { deriveS256Challenge } from '../../../common/crypto/pkce.util';
import {
  ClientAuthenticationService,
  InvalidClientError,
} from '../../clients/client-authentication.service';
import type { TokenEndpointAuthMethod } from '../../clients/client.service';
import { AuthorizationCodeService } from '../code/authorization-code.service';
import { TokenError } from './token.errors';
import { TokenService } from './token.service';

/** Reply members the `/token` controller needs (Fastify). Declared structurally like HttpReply. */
interface TokenReply {
  status(code: number): TokenReply;
  header(name: string, value: string): TokenReply;
  send(payload: unknown): unknown;
}

/** PKCE code_verifier charset/length (RFC 7636 ?4.1). */
const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Collapse a possibly-array form value to a single string, or flag a repeated parameter. */
function single(value: unknown): string | undefined | typeof DUPLICATE {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return DUPLICATE;
  return String(value);
}
const DUPLICATE = Symbol('duplicate-param');

interface ClientAuth {
  clientId: string;
  method: TokenEndpointAuthMethod;
  secret?: string;
}

/**
 * `POST /token` grant `authorization_code` (B4.4, spec ?8/?9.3/?9.5).
 *
 * Order (so a bad request never destroys a valid code ? INV-13): parse form => resolve client
 * auth => authenticate client => check the client may use this grant => consume+bind the code
 * (atomic, binds client_id/redirect_uri/PKCE challenge) => issue tokens. Every response (success
 * or error) is `no-store`; 401 `invalid_client` via Basic carries `WWW-Authenticate`. OAuth
 * errors are rendered here, not via the global filter (which maps by status only).
 */
@Controller()
export class TokenController {
  private readonly logger = new Logger(TokenController.name);

  constructor(
    private readonly clientAuth: ClientAuthenticationService,
    private readonly codes: AuthorizationCodeService,
    private readonly tokens: TokenService,
  ) {}

  @Post('/token')
  async token(@Req() req: HttpRequest, @Res() reply: TokenReply): Promise<unknown> {
    noStore(reply);
    try {
      return await this.handle(req, reply);
    } catch (err) {
      return this.renderError(req, reply, err);
    }
  }

  private async handle(req: HttpRequest, reply: TokenReply): Promise<unknown> {
    this.assertFormContentType(req);
    const body = this.parseForm(req);

    const grantType = body.get('grant_type');
    if (grantType !== 'authorization_code') {
      throw new TokenError('unsupported_grant_type');
    }

    // 1) Client authentication (before touching the code).
    const auth = this.resolveClientAuth(req, body);
    let client;
    try {
      client = await this.clientAuth.authenticate(auth);
    } catch (e) {
      if (e instanceof InvalidClientError) {
        throw new TokenError('invalid_client', HttpStatus.UNAUTHORIZED);
      }
      throw e;
    }

    // 2) The client must be allowed to use this grant.
    if (!client.grantTypes.includes('authorization_code')) {
      throw new TokenError('unauthorized_client');
    }

    // 3) PKCE verifier format (cheap, before Redis).
    const code = body.get('code');
    const redirectUri = body.get('redirect_uri');
    const verifier = body.get('code_verifier');
    if (!code || !redirectUri || !verifier || !CODE_VERIFIER_RE.test(verifier)) {
      throw new TokenError('invalid_grant');
    }

    // 4) Atomic consume-with-binding: client_id + redirect_uri + PKCE challenge must all match,
    // otherwise the code is left intact (INV-13). A mismatch/missing/expired code => invalid_grant.
    const challenge = deriveS256Challenge(verifier);
    const data = await this.codes.consume(code, client.clientId, redirectUri, challenge);
    if (!data) {
      throw new TokenError('invalid_grant');
    }

    // 5) A `resource` in the body (RFC 8707) may only confirm the bound resource, never change aud.
    const bodyResource = body.get('resource');
    if (bodyResource !== undefined && bodyResource !== data.resource) {
      throw new TokenError('invalid_target');
    }

    const audit = { ip: req.ip, requestId: req.id };
    const response = await this.tokens.issueForAuthorizationCode(client, data, audit);
    return reply.status(HttpStatus.OK).send(response);
  }

  private assertFormContentType(req: HttpRequest): void {
    const raw = req.headers['content-type'];
    const contentType = Array.isArray(raw) ? raw[0] : raw;
    const mediaType = contentType?.split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/x-www-form-urlencoded') {
      throw new TokenError('invalid_request');
    }
  }

  /** Read the parsed form body; a repeated parameter (array value) => invalid_request. */
  private parseForm(req: HttpRequest): Map<string, string> {
    const source = (req.body ?? {}) as Record<string, unknown>;
    const map = new Map<string, string>();
    for (const key of Object.keys(source)) {
      const value = single(source[key]);
      if (value === DUPLICATE) {
        throw new TokenError('invalid_request');
      }
      if (value !== undefined) {
        map.set(key, value);
      }
    }
    return map;
  }

  /**
   * Decide the client authentication method (RFC 6749 ?2.3): Basic header => client_secret_basic;
   * client_secret in body => client_secret_post; only client_id => none. Using more than one
   * method is invalid_request; a client_id in the body that disagrees with Basic is invalid_client;
   * a completely absent client_id is invalid_client.
   */
  private resolveClientAuth(req: HttpRequest, body: Map<string, string>): ClientAuth {
    const basic = this.parseBasic(basicHeader(req));
    const bodyClientId = body.get('client_id');
    const bodySecret = body.get('client_secret');

    if (basic && bodySecret !== undefined) {
      throw new TokenError('invalid_request');
    }

    if (basic) {
      if (bodyClientId !== undefined && bodyClientId !== basic.clientId) {
        throw new TokenError('invalid_client', HttpStatus.UNAUTHORIZED);
      }
      return { clientId: basic.clientId, method: 'client_secret_basic', secret: basic.secret };
    }

    if (!bodyClientId) {
      throw new TokenError('invalid_client', HttpStatus.UNAUTHORIZED);
    }
    if (bodySecret !== undefined) {
      return { clientId: bodyClientId, method: 'client_secret_post', secret: bodySecret };
    }
    return { clientId: bodyClientId, method: 'none' };
  }

  /** Decode an HTTP Basic header into client credentials (RFC 6749 ?2.3.1). */
  private parseBasic(header: string | undefined): { clientId: string; secret: string } | null {
    if (!header) {
      return null;
    }
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) {
      throw new TokenError('invalid_client', HttpStatus.UNAUTHORIZED);
    }
    // Credentials are form-urlencoded before base64 (RFC 6749 ?2.3.1 Appendix B).
    // A malformed percent-encoding (e.g. `%ZZ`) throws URIError => treat as bad credentials.
    try {
      const clientId = decodeURIComponent(decoded.slice(0, sep));
      const secret = decodeURIComponent(decoded.slice(sep + 1));
      return { clientId, secret };
    } catch {
      throw new TokenError('invalid_client', HttpStatus.UNAUTHORIZED);
    }
  }

  private renderError(req: HttpRequest, reply: TokenReply, err: unknown): unknown {
    const tokenError =
      err instanceof TokenError
        ? err
        : new TokenError('server_error', HttpStatus.INTERNAL_SERVER_ERROR);
    if (!(err instanceof TokenError)) {
      // Infrastructure failure (sign/DB/Redis/audit): fail-closed, no token, no leak of details.
      this.logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
    // RFC 6749 §5.2: a 401 to a client authenticating via Basic must include WWW-Authenticate.
    if (tokenError.code === 'invalid_client' && basicHeader(req) !== undefined) {
      reply.header('WWW-Authenticate', 'Basic realm="token"');
    }
    return reply.status(tokenError.status).send({
      error: tokenError.code,
      error_description: descriptionFor(tokenError.code),
    });
  }
}

/** The `Authorization: Basic …` header (first value) if present, else undefined. */
function basicHeader(req: HttpRequest): string | undefined {
  const raw = req.headers['authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header && /^Basic /i.test(header) ? header : undefined;
}

/** Static, non-leaking descriptions (never echo client input). */
function descriptionFor(code: string): string {
  switch (code) {
    case 'invalid_request':
      return 'The request is missing a parameter or is otherwise malformed.';
    case 'invalid_client':
      return 'Client authentication failed.';
    case 'invalid_grant':
      return 'The authorization code is invalid, expired, or already used.';
    case 'unauthorized_client':
      return 'The client is not authorized to use this grant type.';
    case 'unsupported_grant_type':
      return 'The grant type is not supported.';
    case 'invalid_target':
      return 'The requested resource is invalid.';
    default:
      return 'The authorization server encountered an unexpected condition.';
  }
}

/** Mark a response as uncacheable (RFC 6749 ?5.1 / ?5.2). */
function noStore(reply: TokenReply): void {
  reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
}
