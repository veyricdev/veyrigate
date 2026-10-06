import { Module } from '@nestjs/common';
import { ResourceService } from './resource.service';

/** Resource registry (B3.2). */
@Module({
  providers: [ResourceService],
  exports: [ResourceService],
})
export class ResourcesModule {}
