import { FederationError } from './federation.errors';

/** Ceiling on a provider response body (DEBT-191, F16): token/userinfo/emails JSON is tiny. */
export const PROVIDER_MAX_BODY_BYTES = 64 * 1024;

/**
 * The single outbound HTTP helper for provider calls (B5.1, F2). Only registry URLs reach it.
 * - `AbortSignal.timeout`, `redirect: 'error'` (a 3xx never follows to an unvetted host).
 * - No retry: the token exchange spends a single-use code (not idempotent).
 * - The body is streamed with a 64 KB ceiling: past it the stream is cancelled, never read to the end.
 * - Any network error / timeout / non-2xx / oversized or invalid JSON =>
 *   `FederationError('provider_unavailable')`.
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
    return JSON.parse(await readCapped(res));
  } catch {
    throw new FederationError('provider_unavailable');
  }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > PROVIDER_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('provider body too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
