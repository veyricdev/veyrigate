import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { TOKEN_ERROR_CODES } from '../../modules/oauth/token/token.errors';
import { AuditAction } from '../../modules/security/audit/audit-action.enum';
import type { AuditEvent } from '../../modules/security/audit/audit.types';

/**
 * Prometheus metrics (B7.2, spec #16). One module-level registry, never the client library's global
 * `register` and never a Nest provider (no DI change for the ~25 int-specs). Every label has a
 * finite value set: no user/client/tenant id, email, IP, family, kid, reason, scope or raw path.
 */
export const registry = new Registry();

const RESULTS = ['success', 'failure'] as const;
const ROTATION_MODES = ['normal', 'emergency'] as const;
export const TOKEN_ENDPOINTS = ['token', 'revoke'] as const;
export type TokenEndpoint = (typeof TOKEN_ENDPOINTS)[number];
export const HTTP_LABELS = ['method', 'route', 'status_class'] as const;
/** Detached writes whose failure the caller never sees (DEBT-666, D91.2/D91.3). */
export const BACKGROUND_WRITES = ['register', 'forgot', 'resend_verify', 'auth_mail'] as const;
export type BackgroundWrite = (typeof BACKGROUND_WRITES)[number];
/** Why the SMTP mailer dropped a mail without sending it (DEBT-683, D95.11). */
export const MAIL_DROP_REASONS = ['queue_full', 'shutdown'] as const;
export type MailDropReason = (typeof MAIL_DROP_REASONS)[number];
/** Wire error of a refused admin API call (401/403, DEBT-126, D97.7). */
export const ADMIN_DENY_REASONS = [
  'invalid_token',
  'insufficient_scope',
  'forbidden',
  'step_up_required',
] as const;
/** Audit actions written by CLIs whose last timestamp the app polls (DEBT-618, D97.19/D97.20). */
export const AUDIT_ALERT_WATCHED = ['ADMIN_RECOVERED', 'ADMIN_BOOTSTRAPPED'] as const;
/** Which client-auth failure bucket answered 429 (DEBT-072, D97.16). */
export const CLIENT_AUTH_LIMIT_SCOPES = ['source', 'client', 'unknown_client'] as const;
export type ClientAuthLimitScope = (typeof CLIENT_AUTH_LIMIT_SCOPES)[number];

const auditEvents = new Counter({
  name: 'sso_audit_events_total',
  help: 'Audit events recorded, by action and result (counted before the write; failed writes are also in sso_audit_write_failures_total).',
  labelNames: ['action', 'result'] as const,
  registers: [registry],
});

const auditWriteFailures = new Counter({
  name: 'sso_audit_write_failures_total',
  help: 'Audit events whose write to the audit log failed, by action.',
  labelNames: ['action'] as const,
  registers: [registry],
});

const keyRotations = new Counter({
  name: 'sso_signing_key_rotations_total',
  help: 'Signing key rotations (audited), by mode and result.',
  labelNames: ['mode', 'result'] as const,
  registers: [registry],
});

const tokenErrors = new Counter({
  name: 'sso_token_endpoint_errors_total',
  help: 'OAuth error responses of /token and /revoke, by endpoint and error code.',
  labelNames: ['endpoint', 'error'] as const,
  registers: [registry],
});

const backgroundWriteFailures = new Counter({
  name: 'sso_background_write_failures_total',
  help: 'Failed detached writes (registration, password reset, verify mail resend) and auth mail sends, by what.',
  labelNames: ['what'] as const,
  registers: [registry],
});

const mailQueueDepth = new Gauge({
  name: 'sso_mail_queue_depth',
  help: 'Mails accepted by the SMTP mailer and not yet sent or failed.',
  registers: [registry],
});

const mailDropped = new Counter({
  name: 'sso_mail_dropped_total',
  help: 'Mails dropped by the SMTP mailer (queue full, or still pending at shutdown), by reason.',
  labelNames: ['reason'] as const,
  registers: [registry],
});

const adminAuthDenied = new Counter({
  name: 'sso_admin_auth_denied_total',
  help: 'Admin API requests refused with 401/403, by wire error.',
  labelNames: ['reason'] as const,
  registers: [registry],
});

const auditAlertLastEvent = new Gauge({
  name: 'sso_audit_alert_last_event_timestamp_seconds',
  help: 'Unix time of the newest audit event of a CLI-written alert action (0 = none), polled from the audit log.',
  labelNames: ['action'] as const,
  registers: [registry],
});

const clientAuthRateLimited = new Counter({
  name: 'sso_client_auth_rate_limited_total',
  help: 'Client authentications refused with 429 by the failure limiter, by bucket (source = per IP, client = global per client_id, unknown_client = global for unknown client_ids).',
  labelNames: ['scope'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'sso_http_request_duration_seconds',
  help: 'HTTP request duration, by method, route template and status class.',
  labelNames: HTTP_LABELS,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const ACTIONS: ReadonlySet<string> = new Set(Object.values(AuditAction));
const isOneOf = <T extends string>(set: readonly T[], v: unknown): v is T =>
  (set as readonly unknown[]).includes(v);

// M4: every finite series exists at 0 from start-up, so `increase()` sees the FIRST event (a
// series born at 1 has no prior sample and the reuse/emergency alerts would never fire).
for (const action of ACTIONS) {
  for (const result of RESULTS) auditEvents.inc({ action, result }, 0);
  auditWriteFailures.inc({ action }, 0);
}
for (const mode of ROTATION_MODES) {
  for (const result of RESULTS) keyRotations.inc({ mode, result }, 0);
}
for (const endpoint of TOKEN_ENDPOINTS) {
  for (const error of TOKEN_ERROR_CODES) tokenErrors.inc({ endpoint, error }, 0);
}
for (const what of BACKGROUND_WRITES) backgroundWriteFailures.inc({ what }, 0);
for (const reason of MAIL_DROP_REASONS) mailDropped.inc({ reason }, 0);
for (const reason of ADMIN_DENY_REASONS) adminAuthDenied.inc({ reason }, 0);
for (const action of AUDIT_ALERT_WATCHED) auditAlertLastEvent.set({ action }, 0);
for (const scope of CLIENT_AUTH_LIMIT_SCOPES) clientAuthRateLimited.inc({ scope }, 0);

/**
 * Count one audit event recorded, before the write (called by `AuditService.record`, DEBT-218). Unknown
 * action/result/mode values are ignored (no new series). Synchronous; never awaits.
 */
export function observeAuditEvent(event: Pick<AuditEvent, 'action' | 'result' | 'metadata'>): void {
  if (!ACTIONS.has(event.action) || !isOneOf(RESULTS, event.result)) return;
  auditEvents.inc({ action: event.action, result: event.result });
  if (event.action === AuditAction.SIGNING_KEY_ROTATED) {
    const mode = event.metadata?.mode;
    if (isOneOf(ROTATION_MODES, mode)) keyRotations.inc({ mode, result: event.result });
  }
}

/** Count one failed audit write (DEBT-218, D97.3); an unknown action is ignored. */
export function observeAuditWriteFailure(action: string): void {
  if (ACTIONS.has(action)) auditWriteFailures.inc({ action });
}

/** Count one OAuth error response of `/token` or `/revoke`; a code outside the union => server_error. */
export function observeTokenError(endpoint: TokenEndpoint, code: string): void {
  if (!isOneOf(TOKEN_ENDPOINTS, endpoint)) return;
  tokenErrors.inc({ endpoint, error: isOneOf(TOKEN_ERROR_CODES, code) ? code : 'server_error' });
}

/** Count one failed detached write or auth mail send (DEBT-666); an unknown `what` is ignored. */
export function observeBackgroundWriteFailure(what: BackgroundWrite): void {
  if (isOneOf(BACKGROUND_WRITES, what)) backgroundWriteFailures.inc({ what });
}

/** Set the number of mails the SMTP mailer holds (sending or queued in the pool, DEBT-683). */
export function setMailQueueDepth(n: number): void {
  mailQueueDepth.set(n);
}

/** Count `n` mails dropped by the SMTP mailer (DEBT-683); an unknown reason is ignored. */
export function observeMailDropped(reason: MailDropReason, n = 1): void {
  if (isOneOf(MAIL_DROP_REASONS, reason)) mailDropped.inc({ reason }, n);
}

/** Count one admin API 401/403 by its wire error (DEBT-126, D97.7); any other value is ignored. */
export function observeAdminAuthDenied(reason: string): void {
  if (isOneOf(ADMIN_DENY_REASONS, reason)) adminAuthDenied.inc({ reason });
}

/** Set the newest audit timestamp (seconds) of a watched alert action (DEBT-618); others ignored. */
export function setAuditAlertLastEvent(action: string, seconds: number): void {
  if (isOneOf(AUDIT_ALERT_WATCHED, action)) auditAlertLastEvent.set({ action }, seconds);
}

/** Count one client auth refused with 429 (DEBT-072, D97.16); an unknown scope is ignored. */
export function observeClientAuthRateLimited(scope: ClientAuthLimitScope): void {
  if (isOneOf(CLIENT_AUTH_LIMIT_SCOPES, scope)) clientAuthRateLimited.inc({ scope });
}
