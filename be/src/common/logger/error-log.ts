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

/** Drop `user:password@` from every URI in `text` (Mongo/Redis connection errors). */
export function scrubUriCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, '$1[redacted]@');
}
