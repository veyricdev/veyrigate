import type { KeyProvider } from '../src/modules/keys/key-provider';

/**
 * DEBT-453: compare exposure sinks (log, body, audit) with the tokens actually signed, instead of an
 * `eyJ` prefix (an audit cursor is base64url JSON and starts with `eyJ` too). Wraps `signJwt` as an
 * own property, not `jest.spyOn`, so `jest.restoreAllMocks()` and spies on the signer keep it.
 */
export function recordIssued(provider: KeyProvider): string[] {
  const issued: string[] = [];
  const sign = provider.signJwt.bind(provider);
  provider.signJwt = async (header, payload) => {
    const jwt = await sign(header, payload);
    issued.push(jwt);
    return jwt;
  };
  return issued;
}

/** A token as it could leak: plain, its signature alone, base64, base64url. */
export const leakForms = (t: string): string[] => [
  t,
  t.split('.')[2],
  Buffer.from(t).toString('base64'),
  Buffer.from(t).toString('base64url'),
];

/** Some form of an issued token in `text` (for checks that collect problems instead of throwing). */
export const hasIssued = (text: string, issued: string[]): boolean =>
  issued.some((t) => leakForms(t).some((f) => text.includes(f)));

/** No form of any issued token in `text`. */
export function expectNoIssued(text: string, issued: string[]): void {
  for (const t of issued) for (const form of leakForms(t)) expect(text).not.toContain(form);
}
