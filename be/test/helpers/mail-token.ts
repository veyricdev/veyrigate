/**
 * The one-time token of a verify/reset mail (DEBT-577, D86.3): the link carries it in the fragment
 * (`…/reset#token=<43>`), never in the query. Accepts the whole mail text or the bare link and
 * throws when the link has a query string or no `#token=` fragment, so every int test that reads a
 * mail token also proves the token never reaches a request line.
 */
export function tokenFromMailLink(text: string): string {
  const raw = /https?:\/\/\S+/.exec(text)?.[0];
  if (!raw) throw new Error('no link in the mail');
  const link = new URL(raw);
  if (link.search !== '') throw new Error(`mail link has a query string: ${link.search}`);
  const m = /^#token=([A-Za-z0-9_-]{43})$/.exec(link.hash);
  if (!m) throw new Error('mail link has no #token=<43> fragment');
  return m[1];
}
