import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { FederationConfig } from '../../config/configuration';

/**
 * Static federation provider registry (B5.1, INV-23, spec §9.9 SSRF constraint).
 *
 * Every endpoint URL is a hard-coded https constant here. There is NO path that takes a provider
 * URL from env, DB, tenant or request: only `clientId`/`clientSecret` come from env, and a provider
 * is `enabled` only when BOTH are set. Integration tests replace the whole registry through the DI
 * token `FEDERATION_PROVIDERS` (`overrideProvider`) with a mock on 127.0.0.1 — never a `mock`
 * provider or a runtime-environment branch in `src/`.
 */
export const FEDERATION_PROVIDERS = 'FEDERATION_PROVIDERS';

export type ProviderName = 'google' | 'github';

/** Timeout of every outbound provider call (token, API, JWKS), ms. */
export const PROVIDER_TIMEOUT_MS = 5000;

export const GOOGLE = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
  scopes: 'openid email',
} as const;

export const GITHUB = {
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  userUrl: 'https://api.github.com/user',
  emailsUrl: 'https://api.github.com/user/emails',
  scopes: 'read:user user:email',
} as const;

interface ProviderBase {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  timeoutMs: number;
}

export interface GoogleProvider extends ProviderBase {
  name: 'google';
  issuers: readonly string[];
  /** Google's signing keys (remote JWKS in production; a local key set in tests). */
  jwks: JWTVerifyGetKey;
}

export interface GithubProvider extends ProviderBase {
  name: 'github';
  userUrl: string;
  emailsUrl: string;
}

export type FederationProvider = GoogleProvider | GithubProvider;

export interface FederationProviders {
  google: GoogleProvider;
  github: GithubProvider;
}

/** Look up an ENABLED provider by route name; anything else (unknown/disabled) => null. */
export function enabledProvider(
  providers: FederationProviders,
  name: string,
): FederationProvider | null {
  if (name !== 'google' && name !== 'github') return null;
  const provider = providers[name];
  return provider.enabled ? provider : null;
}

/** Names of the enabled providers, in display order. */
export function enabledProviderNames(providers: FederationProviders): ProviderName[] {
  return (['google', 'github'] as const).filter((n) => providers[n].enabled);
}

/** Production registry: hard-coded endpoints + credentials from the typed config. */
export function buildFederationProviders(cfg: FederationConfig): FederationProviders {
  const google = {
    clientId: cfg.googleClientId ?? '',
    clientSecret: cfg.googleClientSecret ?? '',
  };
  const github = {
    clientId: cfg.githubClientId ?? '',
    clientSecret: cfg.githubClientSecret ?? '',
  };
  return {
    google: {
      name: 'google',
      enabled: !!google.clientId && !!google.clientSecret,
      ...google,
      authorizeUrl: GOOGLE.authorizeUrl,
      tokenUrl: GOOGLE.tokenUrl,
      scopes: GOOGLE.scopes,
      issuers: GOOGLE.issuers,
      timeoutMs: PROVIDER_TIMEOUT_MS,
      jwks: createRemoteJWKSet(new URL(GOOGLE.jwksUrl), { timeoutDuration: PROVIDER_TIMEOUT_MS }),
    },
    github: {
      name: 'github',
      enabled: !!github.clientId && !!github.clientSecret,
      ...github,
      authorizeUrl: GITHUB.authorizeUrl,
      tokenUrl: GITHUB.tokenUrl,
      userUrl: GITHUB.userUrl,
      emailsUrl: GITHUB.emailsUrl,
      scopes: GITHUB.scopes,
      timeoutMs: PROVIDER_TIMEOUT_MS,
    },
  };
}
