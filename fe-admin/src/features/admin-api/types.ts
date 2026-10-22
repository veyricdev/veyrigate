/**
 * Admin API result as it crosses the server function boundary (run 43 F2). Start serialises a
 * thrown error shallowly (`ShallowErrorPlugin`: message only), so a typed failure is returned as a
 * value instead of thrown; {@link unwrap} turns it back into an {@link AdminRequestError} for Query.
 */
export type AdminApiErrorCode =
  | "unauthenticated"
  | "step_up_required"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "unavailable";

/** The only failure data the browser receives: no token, no header, no raw BE body. */
export interface AdminApiFailure {
  code: AdminApiErrorCode;
  /** Fixed text per code; for `invalid_request`/`conflict` the BE description (plain text, ≤ 200). */
  message: string;
  /** A mutation timed out / failed with 5xx: it may or may not have been applied. */
  uncertain?: true;
}

export type AdminResult<T> = { ok: true; data: T } | { ok: false; error: AdminApiFailure };

/** Client-side error for a typed admin API failure (Query `error`). */
export class AdminRequestError extends Error {
  readonly code: AdminApiErrorCode;
  readonly uncertain: boolean;
  constructor(failure: AdminApiFailure) {
    super(failure.message);
    this.name = "AdminRequestError";
    this.code = failure.code;
    this.uncertain = failure.uncertain === true;
  }
}

export function unwrap<T>(result: AdminResult<T>): T {
  if (result.ok) return result.data;
  throw new AdminRequestError(result.error);
}
