import type { HttpRequest } from '../../common/http/http.types';

/** A Fastify reply subset the CORS helper writes to (header-setting only). */
export interface CorsReply {
  header(name: string, value: string): unknown;
}

/** Read the `Origin` header (first value) if the browser sent one. */
export function requestOrigin(req: HttpRequest): string | undefined {
  const raw = req.headers['origin'];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Dynamic per-client CORS for the OAuth endpoints (spec 9.7, D8; DEBT-019). A hand-written helper
 * rather than `@fastify/cors` because the allowlist is per-client and resolved from the DB AFTER
 * the endpoint knows its client context (never a global static list, never `redirect_uris`).
 *
 * When `allowed` is true the reply echoes the exact `Origin` (never `*`), with NO
 * `Access-Control-Allow-Credentials` (the access token is a Bearer header, not a cookie) and
 * always `Vary: Origin` (so a shared cache cannot serve one origin's response to another).
 * When `allowed` is false NO `Access-Control-Allow-Origin` is set (fail-closed) - `Vary: Origin`
 * is still sent so the (absent) decision is not cached across origins.
 */
export function applyCors(reply: CorsReply, origin: string | undefined, allowed: boolean): void {
  reply.header('Vary', 'Origin');
  if (origin && allowed) {
    reply.header('Access-Control-Allow-Origin', origin);
  }
}

/** Preflight (`OPTIONS`) allow-method/header set: only what the OAuth endpoints actually use. */
export function applyPreflightAllow(reply: CorsReply): void {
  reply.header('Access-Control-Allow-Methods', 'GET, POST');
  reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  reply.header('Access-Control-Max-Age', '600');
}

/** The exact set of paths that answer a CORS preflight — the CORS-enabled OAuth endpoints only. */
export const CORS_PREFLIGHT_PATHS: ReadonlySet<string> = new Set([
  '/userinfo',
  '/token',
  '/revoke',
  '/jwks.json',
  '/.well-known/openid-configuration',
]);

/** The `ClientCorsService` member the preflight hook calls (structural, for a small test double). */
export interface OriginRegistry {
  isOriginRegisteredForAnyClient(origin: string): Promise<boolean>;
}

/** A Fastify preflight reply: the CORS helpers write headers, then we end the exchange. */
interface PreflightReply extends CorsReply {
  code(status: number): PreflightReply;
  send(): unknown;
}

/** A Fastify instance that accepts an `onRequest` hook (structural subset). */
interface HookableFastify {
  addHook(
    name: 'onRequest',
    handler: (request: PreflightRequest, reply: PreflightReply) => Promise<void>,
  ): unknown;
}

/** The request members the preflight hook reads. */
interface PreflightRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Register the dynamic per-client CORS preflight hook (DEBT-019, spec §9.7). `OPTIONS` carries no
 * body, so there is no client context yet — a preflight is allowed when the Origin is registered
 * for ANY client (union allowlist); the real request then re-checks the specific client in the
 * controller. Only {@link CORS_PREFLIGHT_PATHS} answer preflight; everything else falls through.
 *
 * Extracted so `main.ts` (production) and the integration tests run the SAME hook — a test can no
 * longer pass against a hand-copied stand-in while the real wiring is wrong.
 */
export function registerCorsPreflight(fastify: HookableFastify, cors: OriginRegistry): void {
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'OPTIONS') return;
    const path = request.url.split('?')[0];
    if (!CORS_PREFLIGHT_PATHS.has(path)) return;
    const origin = requestOrigin({ headers: request.headers });
    const allowed = origin ? await cors.isOriginRegisteredForAnyClient(origin) : false;
    applyCors(reply, origin, allowed);
    applyPreflightAllow(reply);
    await reply.code(204).send();
  });
}
