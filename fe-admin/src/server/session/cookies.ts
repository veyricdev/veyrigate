import "@tanstack/react-start/server-only";

/**
 * fe-admin cookies (Q-42.1). Names and `Secure` follow the protocol of APP_URL, not NODE_ENV:
 * https => `__Host-fea_*` + Secure; http (localhost dev/E2E) => `fea_*` without Secure (a browser
 * drops `__Host-`/Secure cookies on http). Always HttpOnly, SameSite=Lax, Path=/, host-only.
 * The `fea_` prefix keeps them apart from the IdP's `idp_*` cookies (cookies ignore the port).
 */
export interface CookieNames {
  sid: string;
  tx: string;
  secure: boolean;
}

export function cookieNames(appUrl: string): CookieNames {
  const secure = new URL(appUrl).protocol === "https:";
  const prefix = secure ? "__Host-" : "";
  return { sid: `${prefix}fea_sid`, tx: `${prefix}fea_tx`, secure };
}

/** Serialises one Set-Cookie value; `maxAge` 0 deletes. Session cookie when `maxAge` is omitted. */
export function serializeCookie(
  names: CookieNames,
  name: string,
  value: string,
  maxAge?: number,
): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (names.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Reads a cookie from the request `Cookie` header (first occurrence). */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
