import "@tanstack/react-start/server-only";
import { Redis } from "ioredis";

/**
 * Session Redis client (Q-42.1). Fail fast instead of queueing: a command that cannot be sent or
 * answered within 1 s rejects, so a Redis outage becomes a 503 page, never a hung request.
 */
export function createSessionRedis(url: string): Redis {
  return new Redis(url, {
    commandTimeout: 1000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}
