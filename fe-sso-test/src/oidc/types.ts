/** OIDC `/token` response (spec §9.2; BE `token.service.ts`). */
export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly scope: string;
  readonly id_token?: string;
  readonly refresh_token?: string;
}

/** Claims this client reads off a validated ID token. Access token is opaque to the RP (F7). */
export interface IdTokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | string[];
  readonly exp: number;
  readonly iat: number;
  readonly nonce?: string;
  /** Authorized party (OIDC Core §3.1.3.7 rule 4): required when `aud` is multi-valued. */
  readonly azp?: string;
  readonly [claim: string]: unknown;
}
