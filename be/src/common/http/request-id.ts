import { randomUUID } from 'node:crypto';

/** A client `x-request-id` is kept only when it is a short safe token (DEBT-095, D90.10). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Fastify `genReqId` (DEBT-095): the ONE source of the request id. `req.id` is what pino-http logs
 * (it keeps an existing `req.id`) and what every audit `requestId` carries, and the adapter echoes it
 * in the `x-request-id` response header. Anything else than a safe token (absent, empty, too long,
 * CR/LF, a joined duplicate, an array) is replaced by a fresh UUID: never echoed, never logged.
 */
export function requestIdFrom(req: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const value = req.headers['x-request-id'];
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value) ? value : randomUUID();
}
