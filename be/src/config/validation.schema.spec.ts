import { buildConfig } from './configuration';
import { validateEnv } from './validation.schema';

const BASE: Record<string, string> = {
  ISSUER: 'http://localhost:4000',
  MONGO_URI: 'mongodb://x',
  REDIS_URL: 'redis://x',
  ACCESS_TOKEN_TTL: '900',
  REFRESH_TOKEN_TTL: '2592000',
  SESSION_IDLE_TTL: '28800',
  SESSION_ABSOLUTE_TTL: '2592000',
  KEY_LOCAL_DIR: './keys',
  SMTP_URL: 'smtp://x',
  GOOGLE_CLIENT_ID: 'g',
  GOOGLE_CLIENT_SECRET: 'g',
  GITHUB_CLIENT_ID: 'g',
  GITHUB_CLIENT_SECRET: 'g',
  ADMIN_SEED_EMAIL: 'a@example.com',
  ADMIN_SEED_PASSWORD: 'p',
  CSRF_SECRET: 's',
  RATE_LIMIT_WINDOW: '60',
  RATE_LIMIT_MAX: '100',
};

describe('SESSION_COOKIE_SECURE / session TTL validation (B2.3, C1/C2)', () => {
  it('missing → true', () => {
    expect(validateEnv(BASE).SESSION_COOKIE_SECURE).toBe(true);
  });

  it('"false" in development → false (not coerced to true)', () => {
    const env = validateEnv({ ...BASE, NODE_ENV: 'development', SESSION_COOKIE_SECURE: 'false' });
    expect(env.SESSION_COOKIE_SECURE).toBe(false);
    expect(buildConfig(env).session.cookieSecure).toBe(false);
  });

  it('"false" in production → throws naming the variable (app does not boot)', () => {
    expect(() =>
      validateEnv({ ...BASE, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' }),
    ).toThrow(/SESSION_COOKIE_SECURE: .*production/);
  });

  it('"true" in production → ok', () => {
    const env = validateEnv({ ...BASE, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'true' });
    expect(env.SESSION_COOKIE_SECURE).toBe(true);
  });

  it('rejects values other than "true"/"false"', () => {
    expect(() => validateEnv({ ...BASE, SESSION_COOKIE_SECURE: '0' })).toThrow(
      /SESSION_COOKIE_SECURE/,
    );
  });

  it('SESSION_IDLE_TTL > SESSION_ABSOLUTE_TTL → throws', () => {
    expect(() =>
      validateEnv({ ...BASE, SESSION_IDLE_TTL: '100', SESSION_ABSOLUTE_TTL: '50' }),
    ).toThrow(/SESSION_IDLE_TTL: .*SESSION_ABSOLUTE_TTL/);
  });
});

describe('CLIENT_SECRET_GRACE_TTL (B3.1, tech-lead C2 — spec §17 still open)', () => {
  it('missing → defaults to 7 days (604800s), same pattern as session TTLs', () => {
    expect(validateEnv(BASE).CLIENT_SECRET_GRACE_TTL).toBe(604800);
  });

  it('accepts a positive override', () => {
    expect(validateEnv({ ...BASE, CLIENT_SECRET_GRACE_TTL: '3600' }).CLIENT_SECRET_GRACE_TTL).toBe(
      3600,
    );
  });

  it('rejects zero/negative values, naming the variable', () => {
    expect(() => validateEnv({ ...BASE, CLIENT_SECRET_GRACE_TTL: '0' })).toThrow(
      /CLIENT_SECRET_GRACE_TTL/,
    );
    expect(() => validateEnv({ ...BASE, CLIENT_SECRET_GRACE_TTL: '-1' })).toThrow(
      /CLIENT_SECRET_GRACE_TTL/,
    );
  });
});
