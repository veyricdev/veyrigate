/**
 * Shared Fastify request/reply shapes for HTML + OAuth controllers (DEBT-022).
 *
 * The UI and `/authorize` controllers previously each declared their own ad-hoc `Request`/`Reply`
 * interfaces over the handful of Fastify members they touch. They had drifted (different optional
 * fields, duplicated `view`/`redirect` signatures). These shared types are the single definition:
 * controllers extend them when they need an extra member, instead of redeclaring the base.
 *
 * They intentionally cover only what the controllers use (no full Fastify typing) so a test double
 * stays small; every member mirrors the real Fastify/`@fastify/*` plugin signature.
 */

/** Members of a Fastify request the HTML/OAuth controllers read. */
export interface HttpRequest {
  cookies?: Record<string, string | undefined>;
  body?: unknown;
  ip?: string;
  id?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Members of a Fastify reply the HTML/OAuth controllers call. */
export interface HttpReply {
  status(code: number): HttpReply;
  view(template: string, data: Record<string, unknown>): unknown;
  redirect(url: string, status?: number): unknown;
  setCookie(name: string, value: string, options: object): unknown;
  clearCookie(name: string, options: object): unknown;
}
