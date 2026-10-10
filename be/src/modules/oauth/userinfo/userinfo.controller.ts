import { Controller, Get, Header, HttpStatus, Req, Res } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import type { HttpRequest } from '../../../common/http/http.types';
import { applyCors, requestOrigin } from '../../clients/client-cors.helper';
import { ClientCorsService } from '../../clients/client-cors.service';
import { ClientService } from '../../clients/client.service';
import { TokenVerifier } from '../../keys/token-verifier';
import { isAccessTokenLive } from '../access-token-liveness';

/** Reply members the `/userinfo` controller needs (Fastify, structural like TokenReply). */
interface UserinfoReply {
  status(code: number): UserinfoReply;
  header(name: string, value: string): UserinfoReply;
  send(payload: unknown): unknown;
}

/** A User document with only the fields `/userinfo` may expose (never `passwordHash` etc.). */
interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  emailVerifiedAt?: Date | null;
  profile?: Record<string, unknown> | null;
  updatedAt?: Date;
}

/**
 * OIDC `profile` scope claims (OIDC Core 5.1). Whitelisted so an arbitrary key written into the
 * `Mixed` `User.profile` can never leak through `/userinfo`. All are strings except `updated_at`
 * (epoch seconds, derived from `User.updatedAt`, not from `profile`).
 */
const PROFILE_STRING_CLAIMS = [
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'preferred_username',
  'picture',
  'website',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
] as const;

/**
 * `GET /userinfo` (OIDC Core 5.3, spec 11).
 *
 * The access token is taken ONLY from the `Authorization: Bearer` header (never query/body), is
 * verified as a genuine access token (`TokenVerifier.verifyAccessToken`: RS256, `iss`, header
 * `typ=at+jwt`, required claims) so an ID token cannot be replayed here, and must carry scope
 * `openid`. Claims are returned strictly by granted scope from an explicit whitelist - the User
 * document is never spread, so `passwordHash`/`mfaSecret`/`lockTransitionNonce` (all `select:false`
 * anyway) can never escape. Every failure is a 401 `invalid_token` (403 `insufficient_scope` when
 * the only problem is the missing `openid` scope); nothing leaks the precise reason. All responses
 * are `no-store` and carry no PII in headers/logs.
 */
@Controller()
export class UserinfoController {
  constructor(
    @InjectModel('User') private readonly users: Model<UserDoc>,
    private readonly verifier: TokenVerifier,
    private readonly clients: ClientService,
    private readonly cors: ClientCorsService,
  ) {}

  @Get('/userinfo')
  @Header('Cache-Control', 'no-store')
  async userinfo(@Req() req: HttpRequest, @Res() reply: UserinfoReply): Promise<unknown> {
    const token = this.bearerToken(req);
    if (!token) {
      return this.unauthorized(req, reply, 'invalid_token');
    }

    let claims;
    try {
      claims = await this.verifier.verifyAccessToken(token);
    } catch {
      // Any JOSE failure (bad signature, wrong `iss`, missing claim, ID token with `typ: JWT`,
      // `alg` != RS256, expired) collapses to a single opaque 401 (no reason leak).
      return this.unauthorized(req, reply, 'invalid_token');
    }

    // `openid` scope is the one failure that is 403 `insufficient_scope`, not 401 `invalid_token`,
    // so it is checked here rather than folded into the shared liveness gate below.
    const scopes = claims.scope.split(' ').filter(Boolean);
    if (!scopes.includes('openid')) {
      return this.unauthorized(req, reply, 'insufficient_scope', HttpStatus.FORBIDDEN);
    }

    // Shared access-token liveness (same gate as `/introspect`): the issuing client still exists
    // and is still allowed this `aud`, and the `sub` is a well-formed, still-existing user. The
    // `exists` probe does the single projected read `/userinfo` needs, caching the document so the
    // user is fetched exactly once. Any failure collapses to the opaque 401 `invalid_token`.
    const fetched: { user: UserDoc | null } = { user: null };
    const live = await isAccessTokenLive(claims, this.clients, {
      exists: async (id) => {
        fetched.user = await this.users
          .findById(id)
          .select('email emailVerifiedAt profile updatedAt')
          .lean<UserDoc>()
          .exec();
        return fetched.user !== null;
      },
    });
    const user = fetched.user;
    if (!live || user === null) {
      return this.unauthorized(req, reply, 'invalid_token');
    }

    // Dynamic CORS for the real request: the browser's Origin must be allowed for THIS token's
    // client (a token of client B presented from an origin registered only for client A gets no
    // ACAO). Only reached on the success path (a 401/403 carries no PII to protect cross-origin).
    const origin = requestOrigin(req);
    if (origin) {
      applyCors(reply, origin, await this.cors.isOriginAllowedForClient(claims.client_id, origin));
    }

    const body: Record<string, unknown> = { sub: user._id.toHexString() };
    if (scopes.includes('email')) {
      body.email = user.email;
      body.email_verified = user.emailVerifiedAt != null;
    }
    if (scopes.includes('profile')) {
      Object.assign(body, this.profileClaims(user));
    }
    return reply.status(HttpStatus.OK).send(body);
  }

  /** Whitelisted `profile` claims: only present string keys + `updated_at` from `updatedAt`. */
  private profileClaims(user: UserDoc): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const profile = user.profile ?? {};
    for (const key of PROFILE_STRING_CLAIMS) {
      const value = profile[key];
      if (typeof value === 'string') {
        out[key] = value;
      }
    }
    if (user.updatedAt instanceof Date) {
      out.updated_at = Math.floor(user.updatedAt.getTime() / 1000);
    }
    return out;
  }

  /** The `Bearer` token from the single `Authorization` header (scheme case-insensitive). */
  private bearerToken(req: HttpRequest): string | undefined {
    const raw = req.headers['authorization'];
    if (Array.isArray(raw)) {
      return undefined; // a repeated Authorization header is malformed - reject.
    }
    if (!raw) {
      return undefined;
    }
    const match = /^Bearer (.+)$/i.exec(raw.trim());
    return match ? match[1].trim() : undefined;
  }

  /**
   * 401 `invalid_token` (or 403 `insufficient_scope`) with the RFC 6750 `WWW-Authenticate` header.
   * `no-store` is already set by the method-level `@Header`.
   *
   * CORS on the error path uses the UNION allowlist (`isOriginRegisteredForAnyClient`), not a
   * specific client: a failure has no trusted client context yet, and the body carries no PII, so
   * echoing ACAO to any registered Origin lets a SPA read the 401/`WWW-Authenticate` and trigger a
   * refresh instead of seeing an opaque network error. (The success path is stricter: per-client.)
   */
  private async unauthorized(
    req: HttpRequest,
    reply: UserinfoReply,
    error: 'invalid_token' | 'insufficient_scope',
    status: number = HttpStatus.UNAUTHORIZED,
  ): Promise<unknown> {
    const origin = requestOrigin(req);
    if (origin) {
      applyCors(reply, origin, await this.cors.isOriginRegisteredForAnyClient(origin));
    }
    reply.header('WWW-Authenticate', `Bearer error="${error}"`);
    return reply.status(status).send({ error });
  }
}
