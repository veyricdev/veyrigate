import type { Discovery } from "../../src/oidc/discovery";
import type { TransientStore } from "../../src/oidc/transient";

export const ISSUER = "http://localhost:4000";
export const CLIENT_ID = "fe-sso-test";
export const REDIRECT_URI = "http://localhost:5173/callback";

export const discovery: Discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks.json`,
  end_session_endpoint: `${ISSUER}/logout`,
};

export function memStore(seed?: Record<string, string>): TransientStore {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

export function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
