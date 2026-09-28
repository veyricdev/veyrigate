import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { buildConfig, type Config } from './configuration';
import { validateEnv } from './validation.schema';

/**
 * Global config module (B1.2).
 *
 * - `validate: validateEnv` → fail-fast at bootstrap: a missing/invalid env var
 *   throws before the app listens, and the message names the offending var(s).
 * - `load` exposes the typed, namespaced config tree so the rest of the app
 *   reads via `ConfigService.get<Config['app']>('app')` and never touches
 *   `process.env` directly.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      load: [(): Config => buildConfig(validateEnv(process.env))],
    }),
  ],
})
export class ConfigModule {}
