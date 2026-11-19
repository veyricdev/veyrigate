import { AuditAction } from '../../modules/security/audit/audit-action.enum';
import {
  observeAuditEvent,
  observeBackgroundWriteFailure,
  observeClientAuthRateLimited,
  observeMailDropped,
  observeTokenError,
  registry,
  setMailQueueDepth,
  type BackgroundWrite,
  type ClientAuthLimitScope,
  type MailDropReason,
} from './metrics';

/** Current value of one series (undefined when the series does not exist). */
async function value(name: string, labels: Record<string, string>): Promise<number | undefined> {
  const metric = registry.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} not registered`);
  const { values } = await metric.get();
  const hit = values.find((v) =>
    Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want),
  );
  return hit?.value;
}

describe('metrics (B7.2 Task 2)', () => {
  it('series of every finite label combination start at 0 (M4: increase() sees the first event)', async () => {
    for (const action of Object.values(AuditAction)) {
      for (const result of ['success', 'failure']) {
        expect(await value('sso_audit_events_total', { action, result })).toBe(0);
      }
    }
    for (const mode of ['normal', 'emergency']) {
      for (const result of ['success', 'failure']) {
        expect(await value('sso_signing_key_rotations_total', { mode, result })).toBe(0);
      }
    }
    for (const endpoint of ['token', 'revoke']) {
      expect(
        await value('sso_token_endpoint_errors_total', { endpoint, error: 'invalid_grant' }),
      ).toBe(0);
      expect(
        await value('sso_token_endpoint_errors_total', { endpoint, error: 'server_error' }),
      ).toBe(0);
    }
  });

  it('observeAuditEvent adds exactly 1 to its action/result series and nothing else', async () => {
    const labels = { action: AuditAction.TOKEN_ISSUED, result: 'success' };
    const before = (await value('sso_audit_events_total', labels))!;
    const other = (await value('sso_audit_events_total', { ...labels, result: 'failure' }))!;
    observeAuditEvent({ action: AuditAction.TOKEN_ISSUED, result: 'success' });
    expect(await value('sso_audit_events_total', labels)).toBe(before + 1);
    expect(await value('sso_audit_events_total', { ...labels, result: 'failure' })).toBe(other);
  });

  it('SIGNING_KEY_ROTATED adds 1 to both the audit counter and the rotation counter (mode from metadata)', async () => {
    const audit = { action: AuditAction.SIGNING_KEY_ROTATED, result: 'success' };
    const rot = { mode: 'emergency', result: 'success' };
    const a0 = (await value('sso_audit_events_total', audit))!;
    const r0 = (await value('sso_signing_key_rotations_total', rot))!;
    const n0 = (await value('sso_signing_key_rotations_total', { ...rot, mode: 'normal' }))!;
    observeAuditEvent({
      action: AuditAction.SIGNING_KEY_ROTATED,
      result: 'success',
      metadata: { mode: 'emergency', oldKid: 'kid-x' },
    });
    expect(await value('sso_audit_events_total', audit)).toBe(a0 + 1);
    expect(await value('sso_signing_key_rotations_total', rot)).toBe(r0 + 1);
    expect(await value('sso_signing_key_rotations_total', { ...rot, mode: 'normal' })).toBe(n0);
  });

  it('unknown action / result / rotation mode: no new series, no throw', async () => {
    const before = await registry.metrics();
    expect(() =>
      observeAuditEvent({ action: 'BOGUS_ACTION' as AuditAction, result: 'success' }),
    ).not.toThrow();
    expect(() =>
      observeAuditEvent({ action: AuditAction.TOKEN_ISSUED, result: 'weird' as 'success' }),
    ).not.toThrow();
    expect(() =>
      observeAuditEvent({
        action: AuditAction.SIGNING_KEY_ROTATED,
        result: 'failure',
        metadata: { mode: 'sideways' },
      }),
    ).not.toThrow();
    const after = await registry.metrics();
    expect(after).not.toContain('BOGUS_ACTION');
    expect(after).not.toContain('weird');
    expect(after).not.toContain('sideways');
    expect(after.split('\n').length).toBe(before.split('\n').length);
  });

  it('observeTokenError: +1 per endpoint/code; a code outside the union counts as server_error', async () => {
    const ig = { endpoint: 'token', error: 'invalid_grant' };
    const se = { endpoint: 'revoke', error: 'server_error' };
    const ig0 = (await value('sso_token_endpoint_errors_total', ig))!;
    const se0 = (await value('sso_token_endpoint_errors_total', se))!;
    observeTokenError('token', 'invalid_grant');
    observeTokenError('revoke', 'made_up_code');
    expect(await value('sso_token_endpoint_errors_total', ig)).toBe(ig0 + 1);
    expect(await value('sso_token_endpoint_errors_total', se)).toBe(se0 + 1);
    expect(await registry.metrics()).not.toContain('made_up_code');
  });

  it('DEBT-666: the 4 background write failure series start at 0; +1 per call; an unknown what adds nothing', async () => {
    for (const what of ['register', 'forgot', 'resend_verify', 'auth_mail']) {
      expect(await value('sso_background_write_failures_total', { what })).toBe(0);
    }
    const before = await registry.metrics();
    expect(() => observeBackgroundWriteFailure('made_up' as BackgroundWrite)).not.toThrow();
    const after = await registry.metrics();
    expect(after).not.toContain('made_up');
    expect(after.split('\n').length).toBe(before.split('\n').length);
    observeBackgroundWriteFailure('forgot');
    expect(await value('sso_background_write_failures_total', { what: 'forgot' })).toBe(1);
    expect(await value('sso_background_write_failures_total', { what: 'register' })).toBe(0);
  });

  it('DEBT-683 (D95.11): mail dropped series start at 0; +n per call; an unknown reason adds nothing', async () => {
    for (const reason of ['queue_full', 'shutdown']) {
      expect(await value('sso_mail_dropped_total', { reason })).toBe(0);
    }
    const before = await registry.metrics();
    expect(() => observeMailDropped('made_up_reason' as MailDropReason)).not.toThrow();
    const after = await registry.metrics();
    expect(after).not.toContain('made_up_reason');
    expect(after.split('\n').length).toBe(before.split('\n').length);
    observeMailDropped('queue_full');
    observeMailDropped('shutdown', 3);
    expect(await value('sso_mail_dropped_total', { reason: 'queue_full' })).toBe(1);
    expect(await value('sso_mail_dropped_total', { reason: 'shutdown' })).toBe(3);
  });

  it('DEBT-072 (D97.16): client auth 429 series start at 0 per scope; +1 per call; an unknown scope adds nothing', async () => {
    for (const scope of ['source', 'client', 'unknown_client']) {
      expect(await value('sso_client_auth_rate_limited_total', { scope })).toBe(0);
    }
    const before = await registry.metrics();
    expect(() =>
      observeClientAuthRateLimited('made_up_scope' as ClientAuthLimitScope),
    ).not.toThrow();
    const after = await registry.metrics();
    expect(after).not.toContain('made_up_scope');
    expect(after.split('\n').length).toBe(before.split('\n').length);
    observeClientAuthRateLimited('client');
    expect(await value('sso_client_auth_rate_limited_total', { scope: 'client' })).toBe(1);
    expect(await value('sso_client_auth_rate_limited_total', { scope: 'source' })).toBe(0);
  });

  it('DEBT-683 (D95.11): sso_mail_queue_depth is a gauge set to the pending count', async () => {
    expect(await value('sso_mail_queue_depth', {})).toBe(0);
    setMailQueueDepth(7);
    expect(await value('sso_mail_queue_depth', {})).toBe(7);
    setMailQueueDepth(0);
    expect(await value('sso_mail_queue_depth', {})).toBe(0);
  });

  it('never touches the client library global registry', async () => {
    const { register } = await import('@prometheus-io/client');
    expect(await register.metrics()).not.toContain('sso_');
  });
});
