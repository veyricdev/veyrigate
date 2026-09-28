import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

/**
 * Health helper for the Mongoose connection (B1.4).
 *
 * `@nestjs/mongoose` owns the connection lifecycle (open with retry, close on
 * app shutdown when `app.enableShutdownHooks()` is set), so this service only
 * exposes a `ping()` for the readiness probe.
 */
@Injectable()
export class MongoService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

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
