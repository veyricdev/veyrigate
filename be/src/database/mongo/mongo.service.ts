import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { scrubUriCredentials } from '../../common/logger/error-log';
import type { AppConfig } from '../../config/configuration';

const NO_TRANSACTIONS =
  'MongoDB must be a replica set (or mongos): transactions are required (DEBT-483)';

/** DEBT-483: a replica set member (non-empty `setName`) or a mongos router supports transactions. */
export function supportsTransactions(hello: { setName?: unknown; msg?: unknown }): boolean {
  return (typeof hello.setName === 'string' && hello.setName !== '') || hello.msg === 'isdbgrid';
}

/**
 * Health helper for the Mongoose connection (B1.4).
 *
 * `@nestjs/mongoose` owns the connection lifecycle (open with retry, close on
 * app shutdown when `app.enableShutdownHooks()` is set), so this service only
 * exposes a `ping()` for the readiness probe, plus the boot-time transaction check.
 */
@Injectable()
export class MongoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MongoService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService,
  ) {}

  /**
   * DEBT-483: some admin writes and federated provisioning need transactions. Production refuses
   * to boot on a standalone Mongo (or when `hello` cannot be read: fail-closed, fixed message, no
   * `cause` so the URI never reaches Nest's log); development/test only WARN.
   */
  async onApplicationBootstrap(): Promise<void> {
    const production = this.config.getOrThrow<AppConfig>('app').nodeEnv === 'production';
    let hello: { setName?: unknown; msg?: unknown };
    try {
      hello = await this.connection.db!.admin().command({ hello: 1 });
    } catch (err) {
      const detail = `${NO_TRANSACTIONS} — could not read the server topology: ${scrubUriCredentials(
        (err as Error).message ?? String(err),
      )}`;
      if (production) {
        this.logger.error(detail);
        throw new Error(`${NO_TRANSACTIONS} — could not read the server topology`);
      }
      this.logger.warn(detail);
      return;
    }
    if (supportsTransactions(hello)) return;
    if (production) throw new Error(NO_TRANSACTIONS);
    this.logger.warn(`${NO_TRANSACTIONS} — some admin writes will fail`);
  }

  /** Returns true when the admin `ping` command succeeds. Used by `/ready`. */
  async ping(): Promise<boolean> {
    const db = this.connection.db;
    if (!db) {
      return false;
    }
    const res = await db.admin().ping();
    return res?.ok === 1;
  }
}
