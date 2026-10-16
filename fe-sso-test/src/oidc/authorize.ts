import { createPkce } from "./pkce";
import { randomUrlToken } from "./random";
import type { Discovery } from "./discovery";
import {
  saveTransient,
  type Transient,
  type TransientStore,
} from "./transient";

/** Everything needed to start a login — derived from env + discovery. */
export interface AuthorizeConfig {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly resource: string;
  /** Optional; only added when provided (OPEN-2: no default `prompt=none`). */
  readonly prompt?: string;
  /** Tags the persisted transient so `/callback` can route the aud-probe flow (Task 3). */
  readonly purpose?: "login" | "aud-probe";
}

export interface BeginLoginResult {
  readonly url: string;
  readonly transient: Transient;
}

/**
 * Build the `/authorize` URL (code flow + PKCE + resource) and persist the redirect transient.
 *
 * Params (spec §9.1/§9.2, RFC 8707 §2): `response_type=code`, `client_id`,
 * `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`,
 * `resource`. `prompt` is added only when supplied.
 *
 * Security: fresh `state`/`nonce` (≥256-bit) every call — never reused. The PKCE
 * `code_verifier` is kept in the transient and sent ONLY to `/token`; only `code_challenge`
 * leaves in the URL (exposure budget). Method is fixed to `S256`.
 */
export async function beginLogin(
  discovery: Discovery,
  config: AuthorizeConfig,
  store: TransientStore,
  deps: { crypto?: Crypto; now?: () => number } = {},
): Promise<BeginLoginResult> {
  const cryptoImpl = deps.crypto ?? globalThis.crypto;
  const now = deps.now ?? Date.now;

  const pkce = await createPkce(cryptoImpl);
  const state = randomUrlToken(32, cryptoImpl);
  const nonce = randomUrlToken(32, cryptoImpl);

  const transient: Transient = {
    state,
    nonce,
    verifier: pkce.verifier,
    createdAt: now(),
    ...(config.purpose ? { purpose: config.purpose } : {}),
  };
  saveTransient(transient, store);

  const url = new URL(discovery.authorization_endpoint);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", config.clientId);
  params.set("redirect_uri", config.redirectUri);
  params.set("scope", config.scope);
  params.set("state", state);
  params.set("nonce", nonce);
  params.set("code_challenge", pkce.challenge);
  params.set("code_challenge_method", pkce.method);
  params.set("resource", config.resource);
  if (config.prompt) params.set("prompt", config.prompt);

  return { url: url.toString(), transient };
}
