import { Global, Module } from '@nestjs/common';
import { AuditAlertWatch } from './audit/audit-alert-watch';
import { AuditService } from './audit/audit.service';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { RateLimitService } from './rate-limit/rate-limit.service';

/**
 * Audit (B1.7) + multi-dimensional rate limit (B1.8). Global: used across modules. `AuditAlertWatch`
 * (run 97, DEBT-618) polls CLI-written alert actions into a gauge; internal, not exported.
 */
@Global()
@Module({
  providers: [AuditService, AuditAlertWatch, RateLimitService, RateLimitGuard],
  exports: [AuditService, RateLimitService, RateLimitGuard],
})
export class SecurityModule {}
