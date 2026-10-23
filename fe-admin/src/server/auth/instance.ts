import "@tanstack/react-start/server-only";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { serverEnv } from "../env";
import { createDiscovery } from "../oidc/discovery";
import { createSessionRedis } from "../redis";
import { cookieNames } from "../session/cookies";
import { createSessionStore } from "../session/store";
import { createAuth, type Auth } from "./bff";

let auth: Auth | undefined;
const jwksCache = new Map<string, JWTVerifyGetKey>();

/** The process-wide BFF instance, built from the validated server env on first use. */
export function getAuth(): Auth {
  if (auth) return auth;
  const env = serverEnv();
  auth = createAuth({
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID,
    appUrl: env.APP_URL,
    adminResource: env.ADMIN_API_RESOURCE,
    idp: {
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      adminApiBaseUrl: env.ADMIN_API_BASE_URL,
      fetch: globalThis.fetch,
    },
    discovery: createDiscovery(env.OIDC_ISSUER, globalThis.fetch),
    jwks: (uri) => {
      let jwks = jwksCache.get(uri);
      if (!jwks) {
        // `cooldownDuration: 0`: an ID token with a `kid` not yet in the cached JWKS refetches it at
        // once. The default 30s cooldown broke the callback / refresh for 30s after the IdP rotated
        // its key (run 49 Q-49.3). Safe: this set only verifies ID tokens received on the
        // back-channel `/token` call (client authenticated), so no outsider chooses the `kid`.
        jwks = createRemoteJWKSet(new URL(uri), { timeoutDuration: 5000, cooldownDuration: 0 });
        jwksCache.set(uri, jwks);
      }
      return jwks;
    },
    store: createSessionStore({
      redis: createSessionRedis(env.SESSION_REDIS_URL),
      secret: env.SESSION_SECRET,
    }),
    cookies: cookieNames(env.APP_URL),
    now: Date.now,
  });
  return auth;
}
