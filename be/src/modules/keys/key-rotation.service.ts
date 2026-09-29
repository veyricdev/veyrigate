import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TokenConfig } from '../../config/configuration';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import {
  KEY_PROVIDER,
  type KeyProvider,
  type RotationMode,
  type RotationResult,
} from './key-provider';

/**
 * Signing key rotation (spec §6.4). Normal rotation keeps the old key in JWKS
 * for ACCESS_TOKEN_TTL (the longest-lived JWT it could have signed); emergency
 * rotation drops it at once. Every rotation is audited (alert action).
 * Admin endpoint + step-up come in B6.3.
 */
@Injectable()
export class KeyRotationService {
  private readonly retainSec: number;

  constructor(
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.retainSec = config.getOrThrow<TokenConfig>('token').accessTokenTtl;
  }

  async rotate(mode: RotationMode, actorId: string): Promise<RotationResult> {
    const result = await this.keys.rotate(mode, this.retainSec);
    await this.audit.record({
      actorType: 'admin',
      actorId,
      action: AuditAction.SIGNING_KEY_ROTATED,
      targetType: 'signing_key',
      targetId: result.newKid,
      result: 'success',
      metadata: { mode, oldKid: result.oldKid },
    });
    return result;
  }
}
