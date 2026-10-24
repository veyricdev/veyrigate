import "@tanstack/react-start/server-only";

/**
 * DEBT-370: the BFF takes no uploads (`/_serverFn` and `/auth/logout` bodies are small), so a request
 * with a body is refused before the router reads it (zod would otherwise parse a body of any size in
 * memory). Checked on the declared length only: Node's HTTP parser never hands over more bytes than
 * `Content-Length` and rejects a request carrying both `Content-Length` and `Transfer-Encoding`, so
 * the stream is not counted here.
 */
export const MAX_BODY_BYTES = 65_536;

const NO_BODY = new Set(["GET", "HEAD", "OPTIONS"]);

const refuse = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** A fixed-text 400/411/413 when the body is not acceptable, `undefined` to go on. */
export function rejectBody(request: Request): Response | undefined {
  if (NO_BODY.has(request.method)) return undefined;
  const length = request.headers.get("content-length");
  if (length === null) return request.body === null ? undefined : refuse(411, "Length Required");
  if (!/^\d+$/.test(length)) return refuse(400, "Bad Request");
  if (Number(length) > MAX_BODY_BYTES) return refuse(413, "Payload Too Large");
  return undefined;
}
