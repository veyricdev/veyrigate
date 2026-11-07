/**
 * X3 cookie-topology suite (run 73) — hermetic env, derived from the default E2E env (same Mongo
 * `sso-idp-e2e`, Redis `/2`, keyset `e2e/.keys`; never flushed). Topology, all on `*.localhost`
 * (resolved to loopback by every browser, no `hosts` change) behind ONE local TLS port:
 *
 *  - IdP              `https://idp.alpha.localhost:8443` → BE http `127.0.0.1:4100`
 *  - RP same-site     `https://app.alpha.localhost:8443` → fe-sso-test Vite `127.0.0.1:5273`
 *  - RP cross-site    `https://app.beta.localhost:8443`  → fe-sso-test Vite `127.0.0.1:5274`
 *
 * `localhost` acts as a TLD in the PSL, so `alpha.localhost` is the registrable domain: alpha ↔ idp
 * is same-site, beta ↔ idp is cross-site. `x3-alpha`/`x3-beta` are seeded by `seed:e2e-admin` when
 * `E2E_X3=1` (E2E-only seed).
 */
import { beEnv, feEnv } from "../config/env";

export const X3_TLS_PORT = 8443;
export const X3_IDP_HOST = "idp.alpha.localhost";
export const X3_ISSUER = `https://${X3_IDP_HOST}:${X3_TLS_PORT}`;
export const X3_BE_PORT = 4100;

export type X3Label = "alpha" | "beta";

export interface X3Rp {
  readonly label: X3Label;
  readonly clientId: string;
  readonly origin: string;
  readonly vitePort: number;
  readonly topology: "same-site" | "cross-site";
}

export const X3_RPS: Record<X3Label, X3Rp> = {
  alpha: {
    label: "alpha",
    clientId: "x3-alpha",
    origin: `https://app.alpha.localhost:${X3_TLS_PORT}`,
    vitePort: 5273,
    topology: "same-site",
  },
  beta: {
    label: "beta",
    clientId: "x3-beta",
    origin: `https://app.beta.localhost:${X3_TLS_PORT}`,
    vitePort: 5274,
    topology: "cross-site",
  },
};

/** BE env: the default E2E env on :4100, https issuer, `Secure` cookies (=> `__Host-` names). */
export function x3BeEnv(): Record<string, string> {
  return {
    ...beEnv(),
    PORT: String(X3_BE_PORT),
    ISSUER: X3_ISSUER,
    SESSION_COOKIE_SECURE: "true",
    E2E_X3: "1",
  };
}

/** fe-sso-test env for one X3 RP (public origin is the TLS proxy, not the Vite port). */
export function x3RpEnv(rp: X3Rp): Record<string, string> {
  return {
    ...feEnv(),
    VITE_OIDC_ISSUER: X3_ISSUER,
    VITE_OIDC_CLIENT_ID: rp.clientId,
    VITE_OIDC_REDIRECT_URI: `${rp.origin}/callback`,
    VITE_OIDC_POST_LOGOUT_URI: `${rp.origin}/`,
    VITE_OIDC_RESOURCE: `${X3_ISSUER}/demo/`,
    VITE_DEMO_API_URL: `${X3_ISSUER}/demo/me`,
  };
}
