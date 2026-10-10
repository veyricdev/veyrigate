import { HttpStatus } from '@nestjs/common';

/**
 * OAuth 2.0 `/token` error codes used by B4.4 (RFC 6749 ?5.2, RFC 8707 ?2).
 * The global `OAuthExceptionFilter` maps errors by HTTP status, so it cannot emit these
 * grant-specific codes ? the `/token` controller renders `TokenError` directly instead.
 */
export type TokenErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'server_error';

/**
 * Domain error for `/token`. Deliberately NOT an `HttpException`: the controller owns the exact
 * `{error, error_description}` body, the status, and the `no-store`/`WWW-Authenticate` headers.
 * The message/description must never contain a secret, code, or verifier (INV-20).
 */
export class TokenError extends Error {
  constructor(
    readonly code: TokenErrorCode,
    readonly status: number = HttpStatus.BAD_REQUEST,
  ) {
    super(code);
    this.name = 'TokenError';
  }
}
