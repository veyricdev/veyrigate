import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * Health module (B1.3). Mongo/Redis services are provided globally by the
 * database modules, so this module only registers the probe controller.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
