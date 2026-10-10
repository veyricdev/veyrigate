import { Controller, HttpStatus, Logger, Post, Req, Res } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { sha256 } from '../../../common/crypto/crypto.util';
import { FormParseError, assertFormContentType, parseForm } from '../../../common/http/form';
import type { HttpRequest } from '../../../common/http/http.types';
import {
  ClientAuthenticationService,
  InvalidClientError,
} from '../../clients/client-authentication.service';
import {
  ClientAuthRequestError,
  basicAuthHeader,
  resolveClientAuth,
} from '../../clients/client-auth-request';
import { ClientService, type Client } from '../../clients/client.service';
import { TokenVerifier } from '../../keys/token-verifier';
import { isAccessTokenLive } from '../access-token-liveness';

/** Reply members the `/introspect` controller needs (Fastify, structural). */
interface IntrospectReply {
  status(code: number): IntrospectReply;
  header(name: string, value: string): IntrospectReply;
  send(payload: unknown): unknown;
}

/** The stored refresh fields introspection reads (never the hash, never `_id`/`familyId`). */
interface RefreshDoc {
  clientId: string;
  userId: { toHexString(): string };
  scope: string[];
  resource: string;
  issuedAt?: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  familyRevokedAt?: Date | null;
}

/** RFC 7662 inactive response — the SAME shape for every negative case (anti-enumeration). */
const INACTIVE = { active: false } as const;

/**
 * `POST /introspect` (RFC 7662, spec 11/214).
 *
 * Caller auth is MANDATORY and only a confidential client (`client_secret_basic`/`post`) may call
 * - a `none`/public client or bad/absent credentials gets 401 `invalid_client` and NO
 * introspection body (the endpoint is never an unauthenticated oracle). A resource server
 * registers as a confidential client (the `Resource` schema carries no secret).
 *
 * Branch by token SHAPE (the `token_type_hint` is accepted but not trusted, RFC 7662 2.1): a
 * three-part JWT is verified as an access token (`verifyAccessToken` + liveness: client still
 * exists, `aud` still allowed, user still exists); anything else is looked up by `sha256` as a
 * refresh token. Authorization (confused-deputy / IDOR guard): a refresh token is `active` only
 * for its owning client; an access token only when the caller is its `client_id` OR holds its
 * `aud` in `allowedResources`. Every other outcome is the identical `{active:false}` (200).
 *
 * Liveness note (214, OPEN-1 phuong an A): an access token is self-contained and NOT revocable
 * before `exp`; `/introspect` reflects signature + `exp` + client/user existence, but NOT a
 * refresh-family revoke or logout (max staleness = access TTL, 15m). `sid`-based reflection is
 * DEBT-037 (B4.7).
 *
 * Failure semantics: a JOSE/format failure is `{active:false}`; an infrastructure failure
 * (DB/KeyProvider) is 500 `server_error` and NEVER `active:true` (fail-closed). A missing/repeated
 * `token` is 400 `invalid_request`. Every response is `no-store`; the token value is never logged.
 */
@Controller()
export class IntrospectController {
  private readonly logger = new Logger(IntrospectController.name);

  constructor(
    @InjectModel('RefreshToken') private readonly refreshTokens: Model<RefreshDoc>,
    @InjectModel('User') private readonly users: Model<{ _id: Types.ObjectId }>,
    private readonly clientAuth: ClientAuthenticationService,
    private readonly clients: ClientService,
    private readonly verifier: TokenVerifier,
  ) {}

  @Post('/introspect')
  async introspect(@Req() req: HttpRequest, @Res() reply: IntrospectReply): Promise<unknown> {
    noStore(reply);
    try {
      return await this.handle(req, reply);
    } catch (err) {
      return this.renderError(req, reply, err);
    }
  }

  private async handle(req: HttpRequest, reply: IntrospectReply): Promise<unknown> {
    const body = this.parseFormBody(req);

    // Caller auth first - a failure here is the ONLY 4xx that reveals anything, and it reveals
    // only "you are not an authenticated confidential client", never the token's state.
    const caller = await this.authenticateCaller(req, body);

    const token = body.get('token');
    if (!token) {
      throw new IntrospectError('invalid_request', HttpStatus.BAD_REQUEST);
    }

    const result = isJwtShape(token)
      ? await this.introspectAccessToken(token, caller)
      : await this.introspectRefreshToken(token, caller);
    return reply.status(HttpStatus.OK).send(result);
  }

  /** Authenticate the caller; only a confidential client (basic/post) is accepted. */
  private async authenticateCaller(req: HttpRequest, body: Map<string, string>): Promise<Client> {
    let auth;
    try {
      auth = resolveClientAuth(req, body);
    } catch (e) {
      if (e instanceof ClientAuthRequestError) {
        throw new IntrospectError(e.code, e.status);
      }
      throw e;
    }
    // `none`/public callers cannot introspect (no secret to prove they are a trusted party).
    if (auth.method === 'none') {
      throw new IntrospectError('invalid_client', HttpStatus.UNAUTHORIZED);
    }
    try {
      return await this.clientAuth.authenticate(auth);
    } catch (e) {
      if (e instanceof InvalidClientError) {
        throw new IntrospectError('invalid_client', HttpStatus.UNAUTHORIZED);
      }
      throw e; // infrastructure failure => 500 (fail-closed), never active:true.
    }
  }

  /** Access token: verify (JOSE failure => inactive), liveness, then caller authorization. */
  private async introspectAccessToken(
    token: string,
    caller: Client,
  ): Promise<Record<string, unknown>> {
    let claims;
    try {
      claims = await this.verifier.verifyAccessToken(token);
    } catch {
      return INACTIVE; // bad signature / wrong iss / expired / ID token / malformed => inactive.
    }

    // Liveness (OPEN-1 -> A, spec §214): an access token has no denylist before `exp`, so the only
    // live-state signal is current existence — the issuing client still exists AND still allows the
    // token's `aud`, and the `sub` user still exists (well-formed `sub`). Shared with `/userinfo`
    // (`isAccessTokenLive`) so the two cannot drift. A DB fault here propagates => 500 (fail-closed).
    const live = await isAccessTokenLive(claims, this.clients, {
      exists: async (id) => (await this.users.exists({ _id: id })) !== null,
    });
    if (!live) {
      return INACTIVE;
    }

    // Caller authorization (confused-deputy guard): the caller must be the token's client, or a
    // resource server that still holds the token's `aud` in its `allowedResources`.
    const authorized =
      claims.client_id === caller.clientId || caller.allowedResources.includes(claims.aud);
    if (!authorized) {
      return INACTIVE;
    }

    return {
      active: true,
      token_type: 'access_token',
      scope: claims.scope,
      client_id: claims.client_id,
      sub: claims.sub,
      aud: claims.aud,
      exp: claims.exp,
      iat: claims.iat,
      jti: claims.jti,
    };
  }

  /** Refresh token: look up by hash, check liveness, then caller must be the owning client. */
  private async introspectRefreshToken(
    token: string,
    caller: Client,
  ): Promise<Record<string, unknown>> {
    const doc = await this.refreshTokens.findOne({ tokenHash: sha256(token) }).lean<RefreshDoc>();
    if (!doc) {
      return INACTIVE; // unknown value (also covers a random non-JWT string).
    }

    // IDOR guard: only the client the token belongs to may ever see it as active.
    if (doc.clientId !== caller.clientId) {
      return INACTIVE;
    }

    const live =
      doc.revokedAt == null && doc.familyRevokedAt == null && doc.expiresAt.getTime() > Date.now();
    if (!live) {
      return INACTIVE;
    }

    return {
      active: true,
      token_type: 'refresh_token',
      scope: doc.scope.join(' '),
      client_id: doc.clientId,
      sub: doc.userId.toHexString(),
      aud: doc.resource,
      exp: Math.floor(doc.expiresAt.getTime() / 1000),
      ...(doc.issuedAt ? { iat: Math.floor(doc.issuedAt.getTime() / 1000) } : {}),
    };
  }

  /** Shared form parsing (`common/http/form`); a bad content-type / repeated param => 400. */
  private parseFormBody(req: HttpRequest): Map<string, string> {
    try {
      assertFormContentType(req);
      return parseForm(req);
    } catch (e) {
      if (e instanceof FormParseError) {
        throw new IntrospectError('invalid_request', HttpStatus.BAD_REQUEST);
      }
      throw e;
    }
  }

  private renderError(req: HttpRequest, reply: IntrospectReply, err: unknown): unknown {
    const error =
      err instanceof IntrospectError
        ? err
        : new IntrospectError('server_error', HttpStatus.INTERNAL_SERVER_ERROR);
    if (!(err instanceof IntrospectError)) {
      // Infrastructure failure (DB/KeyProvider/audit): fail-closed, no leak of details.
      this.logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
    if (error.code === 'invalid_client' && basicAuthHeader(req) !== undefined) {
      reply.header('WWW-Authenticate', 'Basic realm="introspect"');
    }
    return reply.status(error.status).send({ error: error.code });
  }
}

/** A JWT access token has three dot-separated base64url parts; anything else is opaque (refresh). */
function isJwtShape(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

/** Domain error carrying the OAuth error code + HTTP status for `/introspect`. */
class IntrospectError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'invalid_client' | 'server_error',
    readonly status: number,
  ) {
    super(code);
    this.name = 'IntrospectError';
  }
}

/** Mark a response as uncacheable (RFC 7662 recommends no-store for token metadata). */
function noStore(reply: IntrospectReply): void {
  reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
}
