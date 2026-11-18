import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Run 94 (DEBT-661, D94.3): a reset is two posts. `POST /reset/code {_csrf, token}` exchanges the
 * mailed token for the ticket cookie `idp_reset` (303 `/reset`), then `POST /reset {_csrf,
 * password}` spends the ticket. This drives both over HTTP with a tiny cookie jar, like a browser.
 */
export interface InjectResult {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
}

export const setCookiesOf = (res: InjectResult): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);

/** Name -> value; a Set-Cookie that clears (Max-Age=0 / past Expires / empty value) deletes. */
export class CookieJar {
  readonly values = new Map<string, string>();
  take(res: InjectResult): this {
    for (const line of setCookiesOf(res)) {
      const [pair, ...attrs] = line.split(';').map((p) => p.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const cleared =
        value === '' ||
        attrs.some((a) => /^max-age=0$/i.test(a)) ||
        attrs.some((a) => /^expires=/i.test(a) && Date.parse(a.slice(8)) <= Date.now());
      if (cleared) this.values.delete(name);
      else this.values.set(name, value);
    }
    return this;
  }
  header(): string {
    return [...this.values].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export const csrfOf = (res: InjectResult): string =>
  /name="_csrf" value="([^"]+)"/.exec(res.body)![1];

const inject = (
  app: NestFastifyApplication,
  jar: CookieJar,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, string>,
): Promise<InjectResult> =>
  app
    .inject({
      method,
      url,
      headers: jar.values.size ? { cookie: jar.header() } : {},
      ...(payload ? { payload } : {}),
    })
    .then((res) => (jar.take(res), res));

/** `GET /reset` then `POST /reset/code` in `jar`. */
export async function exchangeResetToken(
  app: NestFastifyApplication,
  token: string,
  jar = new CookieJar(),
): Promise<InjectResult> {
  const form = await inject(app, jar, 'GET', '/reset');
  return inject(app, jar, 'POST', '/reset/code', { _csrf: csrfOf(form), token });
}

/** `GET /reset` (the password form when the jar holds a live ticket) then `POST /reset`. */
export async function postNewPassword(
  app: NestFastifyApplication,
  password: string,
  jar: CookieJar,
): Promise<InjectResult> {
  const form = await inject(app, jar, 'GET', '/reset');
  return inject(app, jar, 'POST', '/reset', { _csrf: csrfOf(form), password });
}

/** The whole reset: exchange the token, then post the password. Returns the failing step's answer. */
export async function resetWithToken(
  app: NestFastifyApplication,
  token: string,
  password: string,
  jar = new CookieJar(),
): Promise<InjectResult> {
  const code = await exchangeResetToken(app, token, jar);
  if (code.statusCode !== 303) return code;
  return postNewPassword(app, password, jar);
}

/** Service-level reset for specs that bypass HTTP: exchange the mailed token, then spend the ticket. */
export async function resetByToken(
  auth: {
    claimResetTicket(token: string): Promise<string | null>;
    resetPassword(ticket: string, password: string): Promise<boolean>;
  },
  token: string,
  password: string,
): Promise<void> {
  const ticket = await auth.claimResetTicket(token);
  if (!ticket || !(await auth.resetPassword(ticket, password))) {
    throw new Error('reset token or ticket refused');
  }
}
