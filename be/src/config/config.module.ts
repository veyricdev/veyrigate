import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { buildConfig, type Config } from './configuration';
import { validateEnv } from './validation.schema';

/**
 * Global config module (B1.2).
 *
 * - The single `load` factory validates the env once (`validateEnv`, DEBT-002)
 *   and throws on a missing/invalid var → fail-fast at bootstrap, before the
 *   app listens; the message names the offending var(s).
 * - It exposes the typed, namespaced config tree so the rest of the app
 *   reads via `ConfigService.get<Config['app']>('app')` and never touches
 *   `process.env` directly.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      load: [(): Config => buildConfig(validateEnv(process.env))],
    }),
  ],
})
export class ConfigModule {}
