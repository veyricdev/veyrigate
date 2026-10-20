import { AuditAction } from '../../modules/security/audit/audit-action.enum';
import { observeAuditEvent, observeTokenError, registry } from './metrics';

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

  it('never touches the client library global registry', async () => {
    const { register } = await import('@prometheus-io/client');
    expect(await register.metrics()).not.toContain('sso_');
  });
});
