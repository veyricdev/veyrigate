import { Controller, Get, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import type { HttpRequest } from '../../../common/http/http.types';
import { applyCors, requestOrigin } from '../../clients/client-cors.helper';
import { ClientCorsService } from '../../clients/client-cors.service';

/** Reply members the discovery controller needs (Fastify, structural). */
interface DiscoveryReply {
  status(code: number): DiscoveryReply;
  header(name: string, value: string): DiscoveryReply;
  send(payload: unknown): unknown;
}

/**
 * OIDC discovery metadata (spec 12, RFC 8414). Every URL is derived from the configured
 * `issuer` so the document can never drift from where the routes are actually mounted. Public,
 * anonymous-readable metadata only - never a secret, private key, or internal URL (INV-19).
 *
 * Deviations from spec 12 (recorded here, approved by tech-lead run 15):
 * - `end_session_endpoint` is NOT advertised yet: `GET /logout` is a confirmation form, not an
 *   RP-initiated logout endpoint (no `id_token_hint`/`post_logout_redirect_uri` handling). Added
 *   in B4.7 (DEBT-038).
 * - `token_endpoint_auth_methods_supported` includes `client_secret_post` (the `/token`
 *   controller accepts it) in addition to spec 12's `client_secret_basic`/`none`.
 * - `grant_types_supported` includes `refresh_token`; `revocation_endpoint`/`introspection_endpoint`
 *   and their auth methods are advertised; `authorization_response_iss_parameter_supported` is
 *   true (RFC 9207 `iss` is set on every `/authorize` redirect).
 * - `scopes_supported` adds `offline_access` (Q4) and `claims_supported` lists the claims the
 *   token + `/userinfo` responses actually carry.
 *
 * CORS: a browser SPA may fetch discovery, so the response echoes a registered Origin (union
 * allowlist across all clients - there is no client context for public metadata).
 */
@Controller()
export class DiscoveryController {
  private readonly issuer: string;

  constructor(
    config: ConfigService,
    private readonly cors: ClientCorsService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
  }

  @Get('/.well-known/openid-configuration')
  async configuration(@Req() req: HttpRequest, @Res() reply: DiscoveryReply): Promise<unknown> {
    reply.header('Cache-Control', 'public, max-age=300');
    // Always `Vary: Origin` (even with no Origin): the response is cacheable (`public, max-age`), so
    // a shared cache must not serve a stored no-Origin copy (no ACAO) to a later CORS request.
    const origin = requestOrigin(req);
    applyCors(
      reply,
      origin,
      origin ? await this.cors.isOriginRegisteredForAnyClient(origin) : false,
    );
    return reply.status(200).send({
      issuer: this.issuer,
      authorization_endpoint: this.url('/authorize'),
      token_endpoint: this.url('/token'),
      userinfo_endpoint: this.url('/userinfo'),
      jwks_uri: this.url('/jwks.json'),
      revocation_endpoint: this.url('/revoke'),
      introspection_endpoint: this.url('/introspect'),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      claims_supported: [
        'iss',
        'sub',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'acr',
        'amr',
        'email',
        'email_verified',
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
        'updated_at',
      ],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      authorization_response_iss_parameter_supported: true,
    });
  }

  /**
   * Join the issuer with an endpoint path. The issuer may itself carry a path (e.g.
   * `https://host/idp`) so we must NOT use `new URL('/x', issuer)` (that drops the issuer path).
   * Strip any trailing slash on the issuer, then append the leading-slash path.
   */
  private url(path: string): string {
    return `${this.issuer.replace(/\/+$/, '')}${path}`;
  }
}
