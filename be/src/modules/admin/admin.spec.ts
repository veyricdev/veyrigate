import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { InvalidClientConfigError, validateCorsOrigin } from '../clients/client.service';
import { DuplicateError } from '../identity/identity.errors';
import { AdminAuthError } from '../identity/tenant-context/admin-auth.errors';
import { toPage } from './admin.dto';
import { toAdminClient, toAdminCredential, toAdminError, toAdminResource } from './admin.mappers';
import { isAdminOpenApiEnabled, registerAdminOpenApi } from './admin.openapi';

/** A stored doc polluted with internal/secret fields the mappers must never pass through. */
const internals = { _id: 'oid', __v: 0, secretHash: '$argon2id$x', tokenHash: 'h', extra: 1 };

describe('admin mappers (allowlist projection, B6.3a)', () => {
  it('toAdminClient: exact key set, no internal fields', () => {
    const view = toAdminClient({
      ...internals,
      clientId: 'c',
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      grantTypes: ['authorization_code'],
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowedCorsOrigins: [],
      allowedResources: [],
      scopes: [],
      tenantId: 't',
    } as never);
    expect(Object.keys(view).sort()).toEqual(
      [
        'allowedCorsOrigins',
        'allowedResources',
        'clientId',
        'clientType',
        'createdAt',
        'disabled',
        'disabledAt',
        'frontchannelLogoutUri',
        'grantTypes',
        'postLogoutRedirectUris',
        'redirectUris',
        'scopes',
        'tenantId',
        'tokenEndpointAuthMethod',
        'updatedAt',
      ].sort(),
    );
    expect(view).toMatchObject({ disabled: false, disabledAt: null, frontchannelLogoutUri: null });
  });

  it('toAdminResource / toAdminCredential: exact key sets', () => {
    expect(
      Object.keys(
        toAdminResource({ ...internals, resourceId: 'r', identifier: 'https://r/', scopes: [] }),
      ).sort(),
    ).toEqual(['identifier', 'resourceId', 'scopes']);
    expect(
      Object.keys(
        toAdminCredential(
          { ...internals, clientId: 'c', version: 1, createdAt: new Date() } as never,
          new Date(),
        ),
      ).sort(),
    ).toEqual(['createdAt', 'expiresAt', 'revokedAt', 'status', 'version']);
  });

  it('toAdminCredential status: active / grace / expired / revoked', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const at = (ms: number) => new Date(now.getTime() + ms);
    const base = { clientId: 'c', version: 1, createdAt: at(-1000) };
    expect(toAdminCredential(base, now).status).toBe('active');
    expect(toAdminCredential({ ...base, expiresAt: at(1000) }, now).status).toBe('grace');
    expect(toAdminCredential({ ...base, expiresAt: at(0) }, now).status).toBe('expired');
    expect(toAdminCredential({ ...base, expiresAt: at(1000), revokedAt: at(-1) }, now).status).toBe(
      'revoked',
    );
  });

  it('toAdminError: domain errors -> 400/409, anything else unchanged (5xx)', () => {
    const invalid = toAdminError(new InvalidClientConfigError('bad')) as AdminAuthError;
    expect([invalid.status, invalid.body]).toEqual([
      400,
      { error: 'invalid_request', error_description: 'bad' },
    ]);
    expect((toAdminError(new DuplicateError('Resource')) as AdminAuthError).status).toBe(409);
    const infra = new Error('mongo down');
    expect(toAdminError(infra)).toBe(infra);
  });
});

describe('toPage', () => {
  const id = (s: string) => s;
  it('limit+1 rows => nextCursor = last item of the page; fewer => null', () => {
    expect(toPage(['a', 'b', 'c'], 2, id, id)).toEqual({ items: ['a', 'b'], nextCursor: 'b' });
    expect(toPage(['a', 'b'], 2, id, id)).toEqual({ items: ['a', 'b'], nextCursor: null });
    expect(toPage([], 2, id, id)).toEqual({ items: [], nextCursor: null });
  });
});

describe('validateCorsOrigin', () => {
  const prod = { allowHttpLocalhost: false };
  const dev = { allowHttpLocalhost: true };
  it.each([
    'https://app.example.com/',
    'https://app.example.com/path',
    'https://app.example.com?q=1',
    'https://app.example.com#f',
    'https://*.example.com',
    '*',
    'null',
    'HTTPS://APP.example.com',
    'http://app.example.com',
    'not a url',
  ])('rejects %s', (o) => {
    expect(() => validateCorsOrigin(o, dev)).toThrow(InvalidClientConfigError);
  });
  it('accepts exact https origins (with port); http://localhost only outside production', () => {
    expect(() => validateCorsOrigin('https://app.example.com', prod)).not.toThrow();
    expect(() => validateCorsOrigin('https://app.example.com:8443', prod)).not.toThrow();
    expect(() => validateCorsOrigin('http://localhost:5173', dev)).not.toThrow();
    expect(() => validateCorsOrigin('http://localhost:5173', prod)).toThrow(
      InvalidClientConfigError,
    );
  });
});

describe('admin OpenAPI gate (Q-27.1)', () => {
  it.each([['production'], [undefined], ['staging'], ['']])(
    'NODE_ENV=%s => disabled, no route registered',
    (env) => {
      const get = jest.fn();
      const app = {
        getHttpAdapter: () => ({ getInstance: () => ({ get }) }),
      } as unknown as INestApplication;
      expect(isAdminOpenApiEnabled({ NODE_ENV: env })).toBe(false);
      expect(registerAdminOpenApi(app, { NODE_ENV: env })).toBe(false);
      expect(get).not.toHaveBeenCalled();
    },
  );
  it('development/test => enabled', () => {
    expect(isAdminOpenApiEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isAdminOpenApiEnabled({ NODE_ENV: 'test' })).toBe(true);
  });
});
