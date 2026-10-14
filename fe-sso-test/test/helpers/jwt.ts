import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair, type JWK } from "jose";

export interface TestKeys {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

/** Generate an RSA key pair for signing test ID tokens; expose its public JWK for JWKS. */
export async function makeKeys(kid = "test-key-1"): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { privateKey, publicJwk, kid };
}

export interface IdTokenOpts {
  issuer?: string;
  audience?: string;
  sub?: string;
  nonce?: string;
  expiresIn?: string | number; // jose format, e.g. "1h" or seconds offset
  alg?: string;
  omitNonce?: boolean;
  /** Override the `aud` claim (string or array) to exercise multi-valued-audience rules. */
  aud?: string | string[];
  /** Set the `azp` claim (authorized party). */
  azp?: string;
}

/** Sign an RS256 ID token with the test key. */
export async function signIdToken(keys: TestKeys, opts: IdTokenOpts = {}): Promise<string> {
  const payload: Record<string, unknown> = {};
  if (!opts.omitNonce) payload.nonce = opts.nonce ?? "test-nonce";
  if (opts.aud !== undefined) payload.aud = opts.aud;
  if (opts.azp !== undefined) payload.azp = opts.azp;
  const alg = opts.alg ?? "RS256";
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg, kid: keys.kid })
    .setIssuer(opts.issuer ?? "http://localhost:4000")
    .setAudience(opts.aud ?? opts.audience ?? "fe-sso-test")
    .setSubject(opts.sub ?? "user-123")
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h");
  // PS256 reuses the RSA key; RS256 is the default.
  return jwt.sign(keys.privateKey);
}

/** Sign an ID token with an HMAC (symmetric) key — used to prove `alg: HS256` is rejected. */
export async function signHs256IdToken(
  secret: Uint8Array,
  opts: IdTokenOpts = {},
): Promise<string> {
  const payload: Record<string, unknown> = {};
  if (!opts.omitNonce) payload.nonce = opts.nonce ?? "test-nonce";
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(opts.issuer ?? "http://localhost:4000")
    .setAudience(opts.audience ?? "fe-sso-test")
    .setSubject(opts.sub ?? "user-123")
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h");
  return jwt.sign(secret);
}

/** Build an UNSECURED JWT (`alg: none`) — used to prove `alg: none` is rejected. */
export function unsecuredIdToken(opts: IdTokenOpts = {}): string {
  const payload: Record<string, unknown> = {
    iss: opts.issuer ?? "http://localhost:4000",
    aud: opts.audience ?? "fe-sso-test",
    sub: opts.sub ?? "user-123",
  };
  if (!opts.omitNonce) payload.nonce = opts.nonce ?? "test-nonce";
  return new UnsecuredJWT(payload)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .encode();
}
