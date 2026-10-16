import { Controller, Get, Header, HttpStatus, NotFoundException, Req, Res } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Types, type Model } from 'mongoose';
import type { AppConfig } from '../../config/configuration';
import { bearerToken } from '../../common/http/bearer';
import type { HttpRequest } from '../../common/http/http.types';
import { applyCors, requestOrigin } from '../clients/client-cors.helper';
import { ClientCorsService } from '../clients/client-cors.service';
import { ClientService } from '../clients/client.service';
import { TokenVerifier } from '../keys/token-verifier';
import { ResourceService } from '../resources/resource.service';
import { SessionService } from '../sessions/session.service';
import { isAccessTokenLive } from '../oauth/access-token-liveness';

/** Reply members the demo controller needs (Fastify, structural like UserinfoReply). */
interface DemoReply {
  status(code: number): DemoReply;
  header(name: string, value: string): DemoReply;
  send(payload: unknown): unknown;
}

/**
 * `GET /demo/me` — a minimal demo resource server (spec §214 B6.5, plan §100 D5) used by the
 * `fe-sso-test` SPA and E2E to exercise a REAL access-token-protected API cross-origin. It is
 * mounted ONLY in `development`/`test` (see `DemoModule`/`isDemoEnabled`); the controller adds a
 * defence-in-depth 404 if it ever reaches a `production` process.
 *
 * Verification mirrors `/userinfo` (shared `bearerToken` + `isAccessTokenLive`) so the two
 * resource endpoints cannot drift, but demo-specific:
 *  - the token is taken ONLY from `Authorization: Bearer` (never query/body);
 *  - `verifyAccessToken` enforces RS256 + `iss` + `typ=at+jwt` + required claims (incl. `scope`);
 *  - `aud` is pinned to the demo resource identifier `${issuer}/demo/` (INV-8): a token for any
 *    other resource (e.g. `other`) is rejected even though it is a valid IdP access token;
 *  - no per-scope requirement (the demo resource declares `scopes:[]`), so there is no 403 branch;
 *  - liveness (sid tombstone / client / aud / user) via the shared gate: a logout of the issuing
 *    session makes the SAME token 401 immediately.
 *
 * Every failure is an opaque 401 `invalid_token` (+ RFC 6750 `WWW-Authenticate`); an infrastructure
 * fault propagates to a 5xx (fail-closed). The 200 body carries only safe claims (never `sid`,
 * DEBT-047; never the raw token) and is `no-store`.
 */
@Controller()
export class DemoController {
  private readonly demoIdentifier: string;
  private readonly isProduction: boolean;

  constructor(
    @InjectModel('User') private readonly users: Model<{ _id: Types.ObjectId }>,
    private readonly verifier: TokenVerifier,
    private readonly clients: ClientService,
    private readonly cors: ClientCorsService,
    private readonly sessions: SessionService,
    private readonly resources: ResourceService,
    config: ConfigService,
  ) {
    const app = config.getOrThrow<AppConfig>('app');
    this.demoIdentifier = `${app.issuer.replace(/\/+$/, '')}/demo/`;
    this.isProduction = app.nodeEnv === 'production';
  }

  @Get('/demo/me')
  @Header('Cache-Control', 'no-store')
  async me(@Req() req: HttpRequest, @Res() reply: DemoReply): Promise<unknown> {
    // Defence in depth (Q-24.2): even if the module were ever loaded in production, the resource is
    // not available there — return 404 (not 401) so it looks like it does not exist.
    if (this.isProduction) {
      throw new NotFoundException();
    }

    const token = bearerToken(req);
    if (!token) {
      return this.unauthorized(req, reply);
    }

    let claims;
    try {
      claims = await this.verifier.verifyAccessToken(token);
    } catch {
      // Any JOSE failure (bad signature, wrong iss, missing claim, ID token typ=JWT, alg!=RS256,
      // expired) collapses to one opaque 401 — no reason leak.
      return this.unauthorized(req, reply);
    }

    // Pin `aud` to THIS resource (INV-8): a genuine access token minted for another resource must
    // not be accepted here. Opaque 401 (no "wrong aud" vs "expired" distinction).
    if (claims.aud !== this.demoIdentifier) {
      return this.unauthorized(req, reply);
    }

    // Shared liveness gate (same as `/userinfo`/`/introspect`, fixed by Task 0): sid tombstone +
    // client still exists + client still allows this aud + user still exists. `false` => 401; an
    // infrastructure fault (Mongo/Redis) propagates to a 5xx (fail-closed) — never a 200/401.
    const live = await isAccessTokenLive(
      claims,
      this.clients,
      { exists: async (id) => (await this.users.exists({ _id: id })) !== null },
      this.sessions,
      this.resources,
    );
    if (!live) {
      return this.unauthorized(req, reply);
    }

    // CORS for the real request: echo ACAO only for an Origin registered for THIS token's client.
    const origin = requestOrigin(req);
    if (origin) {
      applyCors(reply, origin, await this.cors.isOriginAllowedForClient(claims.client_id, origin));
    }

    // Safe claims only — NEVER `sid` (DEBT-047) and never the raw token.
    return reply.status(HttpStatus.OK).send({
      sub: claims.sub,
      aud: claims.aud,
      scope: claims.scope,
      client_id: claims.client_id,
      exp: claims.exp,
      iat: claims.iat,
      jti: claims.jti,
    });
  }

  /**
   * Opaque 401 `invalid_token` with the RFC 6750 `WWW-Authenticate` header. CORS on the error path
   * uses the UNION allowlist (no trusted client context yet, and the 401 body carries no PII), like
   * `/userinfo`, so a SPA can read the 401 cross-origin and refresh instead of a opaque net error.
   */
  private async unauthorized(req: HttpRequest, reply: DemoReply): Promise<unknown> {
    const origin = requestOrigin(req);
    if (origin) {
      applyCors(reply, origin, await this.cors.isOriginRegisteredForAnyClient(origin));
    }
    reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
    return reply.status(HttpStatus.UNAUTHORIZED).send({ error: 'invalid_token' });
  }
}
