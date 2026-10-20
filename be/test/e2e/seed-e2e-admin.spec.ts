import { assertE2eSeedTarget } from './seed-e2e-admin';

// Test-only values (never a real credential).
const SECRET = 'e2e-unit-fe-admin-secret-0123456789abcdef';
const URI = 'mongodb://localhost:27017/sso-idp-e2e?directConnection=true';
const ok = { NODE_ENV: 'test', MONGO_URI: URI, E2E_FE_ADMIN_SECRET: SECRET };

describe('seed-e2e-admin guard (run 39 Task 0)', () => {
  it('accepts NODE_ENV=test + DB sso-idp-e2e + secret >= 32 chars', () => {
    expect(assertE2eSeedTarget(ok)).toEqual({ mongoUri: URI, feAdminSecret: SECRET });
  });

  it.each([
    ['development', { ...ok, NODE_ENV: 'development' }],
    ['production', { ...ok, NODE_ENV: 'production' }],
    ['unset', { ...ok, NODE_ENV: undefined }],
  ])('refuses NODE_ENV=%s', (_label, env) => {
    expect(() => assertE2eSeedTarget(env)).toThrow(/NODE_ENV/);
  });

  it.each([
    ['dev DB', 'mongodb://localhost:27017/sso-idp?directConnection=true'],
    ['prefix', 'mongodb://localhost:27017/sso-idp-e2e2'],
    ['suffix trick', 'mongodb://localhost:27017/x-sso-idp-e2e'],
    ['no DB', 'mongodb://localhost:27017/?directConnection=true'],
    ['no path', 'mongodb://localhost:27017'],
    ['DB only in query', 'mongodb://localhost:27017/sso-idp?x=/sso-idp-e2e'],
    ['malformed escape', 'mongodb://localhost:27017/%E0%A4%A'],
    ['not mongodb', 'http://localhost/sso-idp-e2e'],
    ['unset', undefined],
  ])('refuses MONGO_URI (%s) without echoing the URI', (_label, uri) => {
    let message = '';
    try {
      assertE2eSeedTarget({ ...ok, MONGO_URI: uri });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/sso-idp-e2e/);
    if (uri) expect(message).not.toContain(uri);
  });

  it('accepts credentials / srv in the URI but never echoes them on refusal', () => {
    const withCreds = 'mongodb://u:p%40ss@host1:1,host2:2/sso-idp-e2e?authSource=admin';
    expect(assertE2eSeedTarget({ ...ok, MONGO_URI: withCreds }).mongoUri).toBe(withCreds);
    const bad = 'mongodb+srv://u:topsecretpw@cluster.example/sso-idp';
    expect(() => assertE2eSeedTarget({ ...ok, MONGO_URI: bad })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('topsecretpw') }),
    );
  });

  it.each([
    ['missing', undefined],
    ['short', 'x'.repeat(31)],
  ])('refuses E2E_FE_ADMIN_SECRET %s without echoing it', (_label, secret) => {
    expect(() => assertE2eSeedTarget({ ...ok, E2E_FE_ADMIN_SECRET: secret })).toThrow(
      /E2E_FE_ADMIN_SECRET must be at least 32 characters/,
    );
  });
});
