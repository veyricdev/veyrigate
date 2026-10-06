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

/** Throws `InvalidResourceError` unless `resource` is an absolute URI without a fragment. */
export function validateResourceFormat(resource: string): void {
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    throw new InvalidResourceError(`resource must be an absolute URI: ${resource}`);
  }
  if (parsed.hash) {
    throw new InvalidResourceError(`resource must not contain a fragment: ${resource}`);
  }
}
