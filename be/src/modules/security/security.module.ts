import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { RateLimitService } from './rate-limit/rate-limit.service';

/** Audit (B1.7) + multi-dimensional rate limit (B1.8). Global: used across modules. */
@Global()
@Module({
  providers: [AuditService, RateLimitService, RateLimitGuard],
  exports: [AuditService, RateLimitService, RateLimitGuard],
})
export class SecurityModule {}
