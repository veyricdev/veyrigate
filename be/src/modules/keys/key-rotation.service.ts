import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TokenConfig } from '../../config/configuration';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import type { AuditEventInput } from '../security/audit/audit.types';
import {
  KEY_PROVIDER,
  type KeyMetadata,
  type KeyProvider,
  type RotationMode,
  type RotationResult,
} from './key-provider';

/** Who/where of a rotation (the admin request's audit base: actor, tenant, ip, requestId). */
export type RotationAuditBase = Pick<
  AuditEventInput,
  'actorType' | 'actorId' | 'tenantId' | 'requestId' | 'ip' | 'userAgent'
>;

/**
 * Signing key rotation (spec §6.4). Normal rotation keeps the old key in JWKS
 * for ACCESS_TOKEN_TTL (the longest-lived JWT it could have signed); emergency
 * rotation drops it at once. Every rotation is audited (alert action).
 * Admin endpoint: `POST /admin/keys/rotate` (B6.3c, super_admin + step-up).
 */
@Injectable()
export class KeyRotationService {
  private readonly logger = new Logger(KeyRotationService.name);
  private readonly retainSec: number;

  constructor(
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.retainSec = config.getOrThrow<TokenConfig>('token').accessTokenTtl;
  }

  /** Metadata of the keys currently in JWKS (never key material). */
  list(): Promise<KeyMetadata[]> {
    return this.keys.listKeys();
  }

  /**
   * Failure semantics (B6.3c fold): a failed state write rejects with the old key still active and
   * a best-effort `failure` audit; a rotation that succeeded but could not be audited is NOT rolled
   * back (it is already in effect) — the error propagates (5xx) and is logged with the new kid only.
   * Not idempotent: a retry rotates again (DEBT-158).
   */
  async rotate(mode: RotationMode, base: RotationAuditBase): Promise<RotationResult> {
    const event = {
      ...base,
      action: AuditAction.SIGNING_KEY_ROTATED,
      targetType: 'signing_key',
    } as const;
    let result: RotationResult;
    try {
      result = await this.keys.rotate(mode, this.retainSec);
    } catch (err) {
      await this.audit
        .record({ ...event, result: 'failure', reason: 'rotate_failed', metadata: { mode } })
        .catch(() => undefined);
      throw err;
    }
    try {
      await this.audit.record({
        ...event,
        targetId: result.newKid,
        result: 'success',
        metadata: { mode, oldKid: result.oldKid },
      });
    } catch (err) {
      this.logger.error(
        `Signing key rotated (new kid ${result.newKid}) but the audit write failed`,
      );
      throw err;
    }
    return result;
  }
}
