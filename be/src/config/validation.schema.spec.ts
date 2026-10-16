import { buildConfig } from './configuration';
import { validateEnv } from './validation.schema';

const BASE: Record<string, string> = {
  NODE_ENV: 'development',
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

describe('REDIS_COMMAND_TIMEOUT_MS (DEBT-005 fail-fast)', () => {
  it('missing → defaults to 1000ms and maps to database.redisCommandTimeoutMs', () => {
    const env = validateEnv(BASE);
    expect(env.REDIS_COMMAND_TIMEOUT_MS).toBe(1000);
    expect(buildConfig(env).database.redisCommandTimeoutMs).toBe(1000);
  });

  it('accepts a positive override', () => {
    const env = validateEnv({ ...BASE, REDIS_COMMAND_TIMEOUT_MS: '1500' });
    expect(env.REDIS_COMMAND_TIMEOUT_MS).toBe(1500);
    expect(buildConfig(env).database.redisCommandTimeoutMs).toBe(1500);
  });

  it('rejects zero/negative and over-max values, naming the variable', () => {
    expect(() => validateEnv({ ...BASE, REDIS_COMMAND_TIMEOUT_MS: '0' })).toThrow(
      /REDIS_COMMAND_TIMEOUT_MS/,
    );
    expect(() => validateEnv({ ...BASE, REDIS_COMMAND_TIMEOUT_MS: '-1' })).toThrow(
      /REDIS_COMMAND_TIMEOUT_MS/,
    );
    expect(() => validateEnv({ ...BASE, REDIS_COMMAND_TIMEOUT_MS: '20000' })).toThrow(
      /REDIS_COMMAND_TIMEOUT_MS/,
    );
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

describe('CLIENT_AUTH_FAIL_* rate limit (DEBT-029/039)', () => {
  it('missing → safe defaults (IP 30, client 10)', () => {
    const env = validateEnv(BASE);
    expect(env.CLIENT_AUTH_FAIL_IP_MAX).toBe(30);
    expect(env.CLIENT_AUTH_FAIL_CLIENT_MAX).toBe(10);
  });

  it('accepts positive overrides', () => {
    const env = validateEnv({
      ...BASE,
      CLIENT_AUTH_FAIL_IP_MAX: '5',
      CLIENT_AUTH_FAIL_CLIENT_MAX: '3',
    });
    expect(env.CLIENT_AUTH_FAIL_IP_MAX).toBe(5);
    expect(env.CLIENT_AUTH_FAIL_CLIENT_MAX).toBe(3);
  });

  it('rejects zero/negative values, naming the variable', () => {
    expect(() => validateEnv({ ...BASE, CLIENT_AUTH_FAIL_IP_MAX: '0' })).toThrow(
      /CLIENT_AUTH_FAIL_IP_MAX/,
    );
    expect(() => validateEnv({ ...BASE, CLIENT_AUTH_FAIL_CLIENT_MAX: '-2' })).toThrow(
      /CLIENT_AUTH_FAIL_CLIENT_MAX/,
    );
  });
});

describe('TRUST_PROXY (DEBT-006)', () => {
  it('missing → parses to false (disabled)', () => {
    expect(buildConfig(validateEnv(BASE)).app.trustProxy).toBe(false);
  });

  it('accepts an IP/CIDR list', () => {
    expect(buildConfig(validateEnv({ ...BASE, TRUST_PROXY: '10.0.0.0/8' })).app.trustProxy).toEqual(
      ['10.0.0.0/8'],
    );
  });

  it('rejects true (would enable IP spoofing), naming the variable', () => {
    expect(() => validateEnv({ ...BASE, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });

  it('rejects a numeric hop count (Fastify 5 ignores it), naming the variable', () => {
    expect(() => validateEnv({ ...BASE, TRUST_PROXY: '1' })).toThrow(/TRUST_PROXY/);
  });

  it('rejects an invalid IP/CIDR, naming the variable', () => {
    expect(() => validateEnv({ ...BASE, TRUST_PROXY: 'not-an-ip' })).toThrow(/TRUST_PROXY/);
  });
});

describe('NODE_ENV is required (DEBT-098, Q-26.3: no silent default)', () => {
  it('missing NODE_ENV → throws naming NODE_ENV (app does not boot)', () => {
    const withoutNodeEnv = { ...BASE };
    delete withoutNodeEnv.NODE_ENV;
    expect(() => validateEnv(withoutNodeEnv)).toThrow(/NODE_ENV/);
  });

  it('empty or unknown NODE_ENV → throws naming NODE_ENV', () => {
    expect(() => validateEnv({ ...BASE, NODE_ENV: '' })).toThrow(/NODE_ENV/);
    expect(() => validateEnv({ ...BASE, NODE_ENV: 'prod' })).toThrow(/NODE_ENV/);
  });

  it('each allowed value is accepted as-is', () => {
    for (const value of ['development', 'test', 'production']) {
      expect(validateEnv({ ...BASE, NODE_ENV: value }).NODE_ENV).toBe(value);
    }
  });
});
