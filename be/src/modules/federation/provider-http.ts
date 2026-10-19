import { FederationError } from './federation.errors';

/**
 * The single outbound HTTP helper for provider calls (B5.1, F2). Only registry URLs reach it.
 * - `AbortSignal.timeout`, `redirect: 'error'` (a 3xx never follows to an unvetted host).
 * - No retry: the token exchange spends a single-use code (not idempotent).
 * - Any network error / timeout / non-2xx / invalid JSON => `FederationError('provider_unavailable')`.
 *   The response body and `err.message` are dropped on purpose (may echo secrets/tokens, F9).
 */
export async function providerFetchJson(
  url: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...init.headers },
      body: init.body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new FederationError('provider_unavailable');
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new FederationError('provider_unavailable');
  }
  try {
    return await res.json();
  } catch {
    throw new FederationError('provider_unavailable');
  }
}
