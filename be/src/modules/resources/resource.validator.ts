/**
 * `resource` parameter format validation (B3.2, spec §7, INV-14).
 *
 * Pure format check only — absolute URI, no fragment. Whether the resource is one the
 * requesting client is actually allowed to use is a separate, DB-dependent step
 * (see `ResourceService.resolveForClient`, tech-lead C3): `Resource.identifier` (URI) must be
 * looked up to its `resourceId`, which is then checked against `Client.allowedResources[]` —
 * never compare the URI directly against `allowedResources`.
 */

export class InvalidResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidResourceError';
  }
}

/**
 * Throws `InvalidResourceError` unless `resource` is an absolute URI without a fragment.
 * Fixed messages (DEBT-532): the value is never echoed.
 */
export function validateResourceFormat(resource: string): void {
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    throw new InvalidResourceError('resource must be an absolute URI');
  }
  if (parsed.hash) {
    throw new InvalidResourceError('resource must not contain a fragment');
  }
}

// Control (Cc: NUL, tab, LF, DEL), format (Cf: ZWSP, BOM, bidi) and separator (Z: space, NBSP,
// U+2028) characters: `new URL` drops or encodes them, so the stored raw string (the `aud`) would
// never match the identifier a client sends.
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Z}]/u;
const ALLOWED_SCHEMES = new Set(['https:', 'http:', 'urn:']);

/**
 * Write path only (DEBT-324/329/531): `ResourceService.create/createUnique` (admin create) and the
 * seeds that upsert the model directly (`seedDev`, `seedBootstrap`): the runtime format check plus
 * no whitespace/control/format character anywhere and an https/http/urn scheme.
 * Fixed messages: the value is never echoed. The runtime (`/authorize`, `/token`) keeps
 * `validateResourceFormat`, so an odd identifier stored earlier is merely "not found".
 */
export function validateResourceIdentifier(identifier: string): void {
  if (FORBIDDEN_CHARS.test(identifier)) {
    throw new InvalidResourceError(
      'resource identifier must not contain whitespace or control characters',
    );
  }
  validateResourceFormat(identifier);
  if (!ALLOWED_SCHEMES.has(new URL(identifier).protocol)) {
    throw new InvalidResourceError('resource identifier scheme must be https, http or urn');
  }
}
