/**
 * Log-safe text for errors (B7.4, INV-20). Pino redaction only sees object paths, never the text
 * inside a message or stack, so two kinds of error text are scrubbed before they are logged.
 */

/**
 * An UNEXPECTED error on a request path (the 500 branches): its name, `code` and stack frames, but
 * never its message. A Mongo E11000 message carries `dup key: { email: "..." }`, and any thrown
 * `Error` may echo request input (token, code, email). The request id on the log line correlates
 * it with the audit trail; reproduce locally for the full message.
 */
export function errorForLog(err: unknown): string {
  if (!(err instanceof Error)) return `non-Error thrown (${typeof err})`;
  const code = (err as { code?: unknown }).code;
  const head =
    typeof code === 'string' || typeof code === 'number' ? `${err.name} (code ${code})` : err.name;
  // A message line may itself look like a frame ("    at x (secret)"): never keep text of the message.
  const frames = (err.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line) && !err.message.includes(line.trim()));
  return [head, ...frames].join('\n');
}

/**
 * Drop `user:password@` from every URI in `text` (Mongo/Redis connection errors): the userinfo runs
 * to the LAST `@` of the authority, so a decoded password holding `@` goes too (DEBT-523). Then the
 * value of any `key=value` whose key looks secret (pass/pwd/secret/token/key/cred/auth, e.g.
 * `tlsCertificateKeyFilePassword`, `authMechanismProperties`) is masked; over-masking is the safe side.
 * It runs on the app event loop, so the text is first cut to SCRUB_MAX_CHARS and every regex only
 * starts a match at the beginning of a run (lookbehind): no super-linear backtracking (DEBT-525).
 */
export function scrubUriCredentials(text: string): string {
  return scrubKeyValues(
    truncateForScrub(text).replace(
      /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi,
      '$1[redacted]@',
    ),
  );
}

const SCRUB_MAX_CHARS = 2048;
const SECRET_KEY = /pass|pwd|secret|token|key|cred|auth/i;

/** Cut a long text, dropping the last (possibly half) token so a URI cut before its `@` cannot leak. */
function truncateForScrub(text: string): string {
  if (text.length <= SCRUB_MAX_CHARS) return text;
  const cut = text.slice(0, SCRUB_MAX_CHARS);
  const lastSpace = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'), cut.lastIndexOf('\t'));
  return `${cut.slice(0, lastSpace + 1)}[truncated]`;
}

/** Mask `key=value` when the key looks secret; a non-secret value is searched again (`a=password=x`). */
function scrubKeyValues(text: string): string {
  return text.replace(/(?<![\w.-])([\w.-]+)=([^\s&#;]*)/g, (_m, key: string, value: string) =>
    SECRET_KEY.test(key) ? `${key}=[redacted]` : `${key}=${scrubKeyValues(value)}`,
  );
}
