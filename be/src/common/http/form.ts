import type { HttpRequest } from './http.types';

/**
 * Raised by {@link assertFormContentType}/{@link parseForm} when an `application/x-www-form-urlencoded`
 * request is malformed: a wrong `Content-Type`, or a repeated parameter (an array value, which lets
 * a client smuggle a second `grant_type`/`token`). Deliberately neutral (not an HttpException) so
 * each endpoint maps it to its OWN error-body shape (`/token` -> TokenError, `/introspect` ->
 * IntrospectError), both 400 `invalid_request`.
 */
export class FormParseError extends Error {
  constructor() {
    super('invalid_request');
    this.name = 'FormParseError';
  }
}

/**
 * Require `Content-Type: application/x-www-form-urlencoded` (parameters only compared by media type,
 * a charset parameter is allowed). Shared by `/token`, `/revoke` and `/introspect`.
 */
export function assertFormContentType(req: HttpRequest): void {
  const raw = req.headers['content-type'];
  const contentType = Array.isArray(raw) ? raw[0] : raw;
  const mediaType = contentType?.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') {
    throw new FormParseError();
  }
}

/**
 * Read the parsed form body into a single-valued `Map`. A repeated parameter (Fastify parses it as
 * an array) throws {@link FormParseError} rather than silently taking the first/last value, closing
 * parameter-smuggling. Shared by `/token`, `/revoke` and `/introspect`.
 */
export function parseForm(req: HttpRequest): Map<string, string> {
  const source = (req.body ?? {}) as Record<string, unknown>;
  const map = new Map<string, string>();
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      throw new FormParseError();
    }
    map.set(key, String(value));
  }
  return map;
}
