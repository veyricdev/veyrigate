import { Logger } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { httpDuration } from '../metrics/metrics';
import { METHODS } from '../metrics/metrics.http';
import { buildCsp } from './csp';

/**
 * Errors Fastify raises BEFORE routing (DEBT-239, run 59): a malformed percent-encoding
 * (`FST_ERR_BAD_URL`, 400) or a path param over find-my-way's 100 chars (`FST_ERR_MAX_PARAM_LENGTH`,
 * 414). Without `frameworkErrors` Fastify writes a raw JSON body echoing the path; with it, the
 * request runs in a hook-less context (`fastify@5.12.5` `fastify.js:434,645,670`), so helmet and the
 * `onResponse` metric hook never run. This handler therefore sets the helmet headers itself (same
 * values as the global helmet config in `bootstrap.ts`), answers a fixed body that never echoes the
 * URL, and observes the latency metric once with `route="__unmatched"`. No I/O, never throws.
 */
const HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': buildCsp(),
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'SAMEORIGIN',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
};

const logger = new Logger('HttpEdge');

/** The members of Fastify's error/request/reply the handler touches. */
interface EdgeError {
  statusCode?: unknown;
  code?: unknown;
}
interface EdgeRequest {
  method: string;
}
interface EdgeReply {
  readonly elapsedTime: number;
  code(statusCode: number): unknown;
  headers(values: Record<string, string>): unknown;
  send(payload?: unknown): unknown;
}

export function frameworkErrors(error: EdgeError, request: EdgeRequest, reply: EdgeReply): void {
  const sc = error.statusCode;
  const status =
    Number.isInteger(sc) && (sc as number) >= 400 && (sc as number) <= 499 ? (sc as number) : 500;
  if (status === 500) logger.error(`framework error ${String(error.code ?? 'unknown')}`);
  reply.code(status);
  reply.headers({ ...HEADERS });
  reply.send(status === 500 ? '{"error":"server_error"}' : '{"error":"invalid_request"}');
  httpDuration.observe(
    {
      method: METHODS.has(request.method) ? request.method : 'OTHER',
      route: '__unmatched',
      status_class: `${Math.floor(status / 100)}xx`,
    },
    reply.elapsedTime / 1000,
  );
}

/** The single way the app entries (`main.ts`, E2E entry, `test/full-app.ts`) build their adapter. */
export function createFastifyAdapter(trustProxy?: false | string[]): FastifyAdapter {
  return new FastifyAdapter({ trustProxy, frameworkErrors });
}
