import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import { ClientService } from '../../clients/client.service';
import { isRegisteredRedirectUri } from '../../clients/redirect-uri.validator';
import { TokenVerifier } from '../../keys/token-verifier';

/** Raw RP-initiated logout params (OIDC RP-Initiated Logout), already string-typed by the HTTP layer. */
export interface LogoutParams {
  idTokenHint?: string;
  postLogoutRedirectUri?: string;
  state?: string;
  clientId?: string;
}

/** A verified logout hint: the client it points at (already looked up), and the subject it asserted. */
interface VerifiedHint {
  clientId: string;
  sub: string;
  client: NonNullable<Awaited<ReturnType<ClientService['findByClientId']>>>;
}

/** `state` echoed back to the RP is capped so a hostile hint cannot blow up the redirect URL. */
const MAX_STATE_LENGTH = 512;
/** Default post-logout redirect: every untrusted input fails closed here (GET and POST agree). */
const DEFAULT_REDIRECT = '/login?loggedOut=1';

/**
 * RP-initiated + front-channel logout helpers (B4.7, spec §9.8). It verifies the `id_token_hint`,
 * computes the post-logout redirect by EXACT-MATCH against the hinted client, and builds the list
 * of front-channel RPs to notify. It never mutates session/token state — that is the
 * controller/`SessionService`/`RefreshTokenService`. Every untrusted input fails closed to the
 * default redirect (`/login?loggedOut=1`) so GET and POST reach the identical decision.
 */
@Injectable()
export class LogoutService {
  readonly defaultRedirect = DEFAULT_REDIRECT;
  private readonly issuer: string;

  constructor(
    private readonly clients: ClientService,
    private readonly verifier: TokenVerifier,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
  }

  /**
   * Resolve the absolute post-logout redirect for a request. Returns the default redirect unless
   * ALL of: a hint verifies, (a provided `client_id` matches its `aud`), the hinted client exists,
   * a `post_logout_redirect_uri` is given AND exact-matches that client, and — when a live session
   * exists — the hint `sub` equals the session user. Never trusts a value just because it arrived
   * (e.g. a POST hidden field): GET and POST both call this with the raw params.
   */
  async resolvePostLogoutRedirect(
    params: LogoutParams,
    sessionUserId: string | undefined,
  ): Promise<string> {
    const uri = params.postLogoutRedirectUri;
    if (!uri || !params.idTokenHint) return DEFAULT_REDIRECT;

    const hint = await this.verifyHint(params.idTokenHint);
    if (!hint) return DEFAULT_REDIRECT;
    // A query `client_id` that disagrees with the hint `aud` is a mismatched request -> ignore.
    if (params.clientId && params.clientId !== hint.clientId) return DEFAULT_REDIRECT;
    // A live session whose user is not the hint subject must not drive another user's redirect.
    if (sessionUserId && hint.sub !== sessionUserId) return DEFAULT_REDIRECT;

    // `verifyHint` already loaded (and non-null-checked) the client — reuse it, no second lookup.
    const client = hint.client;
    if (!isRegisteredRedirectUri(client.postLogoutRedirectUris, uri)) return DEFAULT_REDIRECT;

    return this.appendState(uri, params.state);
  }

  /** Verify an `id_token_hint`, also confirming the asserted client still exists. Null on any failure. */
  async verifyHint(idTokenHint: string): Promise<VerifiedHint | null> {
    try {
      const { sub, aud } = await this.verifier.verifyIdTokenHint(idTokenHint);
      const client = await this.clients.findByClientId(aud);
      if (!client) return null;
      return { clientId: aud, sub, client };
    } catch {
      return null;
    }
  }

  /**
   * Front-channel iframes to render for a set of candidate client ids (the RPs that received a code
   * in the session(s) being logged out). Only clients that still exist and registered a
   * `frontchannelLogoutUri` are notified; each iframe `src` is the registered URI plus `iss` (neve
   * a token/PII, exposure budget). De-duplicated and allowlist-only (no input URI reaches here).
   */
  async frontchannelIframes(clientIds: readonly string[]): Promise<string[]> {
    const srcs: string[] = [];
    for (const clientId of new Set(clientIds)) {
      const client = await this.clients.findByClientId(clientId);
      if (!client?.frontchannelLogoutUri) continue;
      const url = new URL(client.frontchannelLogoutUri);
      url.searchParams.set('iss', this.issuer);
      srcs.push(url.toString());
    }
    return srcs;
  }

  /**
   * `frame-src` CSP origins (scheme+host+port) for the given iframe sources; de-duplicated.
   * Defence-in-depth: drop any origin carrying a CSP-breaking character (`;`, `,`, whitespace) so a
   * malformed stored URI can never inject a directive (registration already rejects these, B4.7).
   */
  frameSrcOrigins(iframeSrcs: readonly string[]): string[] {
    const origins = iframeSrcs.map((src) => new URL(src).origin).filter((o) => !/[;,\s]/.test(o));
    return [...new Set(origins)];
  }

  /** Append a capped, URL-encoded `state` to an already-validated redirect URI. */
  private appendState(uri: string, state: string | undefined): string {
    if (!state || state.length > MAX_STATE_LENGTH) return uri;
    const url = new URL(uri);
    url.searchParams.set('state', state);
    return url.toString();
  }
}
