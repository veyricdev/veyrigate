import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';

/**
 * Admin API (B6.1/B6.2) authentication/authorization failure with its exact wire shape. Opaque by
 * design: one code per class of failure, never the reason (wrong aud vs expired vs logged out).
 * Infrastructure faults are NOT this error — they propagate to a 5xx (fail-closed).
 */
export class AdminAuthError extends Error {
  private constructor(
    readonly status: number,
    readonly body: Readonly<Record<string, unknown>>,
    readonly wwwAuthenticate?: string,
  ) {
    super(String(body.error));
  }

  /** 401: missing/invalid/stale token, wrong resource, no `sid`, not live. */
  static invalidToken(): AdminAuthError {
    return new AdminAuthError(401, { error: 'invalid_token' }, 'Bearer error="invalid_token"');
  }

  /** 403: the token lacks the route's `admin.*` scope (RFC 6750 §3.1). */
  static insufficientScope(scope: string): AdminAuthError {
    return new AdminAuthError(
      403,
      { error: 'insufficient_scope' },
      `Bearer error="insufficient_scope", scope="${scope}"`,
    );
  }

  /** 403: not an active admin member of the token's tenant (member vs role NOT distinguished). */
  static forbidden(): AdminAuthError {
    return new AdminAuthError(403, { error: 'forbidden' });
  }

  /** 403: `auth_time` missing/stale/future (B6.2, D3). The RP re-auths with `prompt=login&max_age=0`. */
  static stepUpRequired(): AdminAuthError {
    return new AdminAuthError(403, { error: 'step_up_required', max_age: 0 });
  }

  /**
   * 404 (B6.3a, D-27.c): the target does not exist IN THE TOKEN'S TENANT. Cross-tenant and
   * truly-missing are byte-identical (no oracle), so there is never a description.
   */
  static notFound(): AdminAuthError {
    return new AdminAuthError(404, { error: 'not_found' });
  }

  /** 409 (B6.3a): the write conflicts with current state (duplicate, self-lock). */
  static conflict(description: string): AdminAuthError {
    return new AdminAuthError(409, { error: 'conflict', error_description: description });
  }

  /** 400 (B6.3a): a domain validation failure (redirect URI, origin, resource, ...). */
  static invalidRequest(description: string): AdminAuthError {
    return new AdminAuthError(400, { error: 'invalid_request', error_description: description });
  }
}

interface AdminReply {
  status(code: number): AdminReply;
  header(name: string, value: string): AdminReply;
  send(payload: unknown): unknown;
}

/** Renders `AdminAuthError` as-is (the global OAuth filter would rewrite the body). `no-store`. */
@Catch(AdminAuthError)
export class AdminAuthErrorFilter implements ExceptionFilter {
  catch(err: AdminAuthError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<AdminReply>();
    reply.header('Cache-Control', 'no-store');
    if (err.wwwAuthenticate) reply.header('WWW-Authenticate', err.wwwAuthenticate);
    void reply.status(err.status).send(err.body);
  }
}
