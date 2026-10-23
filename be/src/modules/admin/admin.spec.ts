import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { InvalidClientConfigError, validateCorsOrigin } from '../clients/client.service';
import { DuplicateError } from '../identity/identity.errors';
import { AdminAuthError } from '../identity/tenant-context/admin-auth.errors';
import { AdminTokenGuard } from '../identity/tenant-context/tenant-context';
import { AuditAction } from '../security/audit/audit-action.enum';
import { toPage } from './admin.dto';
import {
  toAdminAuditEvent,
  toAdminClient,
  toAdminConsent,
  toAdminCredential,
  toAdminError,
  toAdminFamily,
  toAdminResource,
  toAdminUser,
} from './admin.mappers';
import { adminOnly, isAdminOpenApiEnabled, registerAdminOpenApi } from './admin.openapi';
import { AdminAuditController } from './admin-audit.controller';
import { AdminClientsController } from './admin-clients.controller';
import { AdminResourcesController } from './admin-resources.controller';
import { AdminUsersController } from './admin-users.controller';

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

describe('admin OpenAPI response schemas (DEBT-290/294)', () => {
  type Schema = {
    type?: string;
    format?: string;
    nullable?: boolean;
    properties?: Record<string, Schema>;
    items?: Schema;
    $ref?: string;
  };
  let doc: OpenAPIObject;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        AdminClientsController,
        AdminResourcesController,
        AdminUsersController,
        AdminAuditController,
      ],
    })
      .overrideGuard(AdminTokenGuard)
      .useValue({})
      .useMocker(() => ({}))
      .compile();
    const app = moduleRef.createNestApplication(new FastifyAdapter());
    doc = adminOnly(SwaggerModule.createDocument(app, new DocumentBuilder().build()));
    await app.close();
  });
  const schema = (name: string) => doc.components!.schemas![name] as Schema;
  const keys = (name: string) => Object.keys(schema(name).properties ?? {}).sort();
  const ref = (path: string, method: string, status: string) =>
    (
      doc.paths[path] as Record<
        string,
        { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }
      >
    )[method].responses[status].content?.['application/json'].schema.$ref;

  it('mapper output keys == schema properties (adding a mapper field without schema => RED)', () => {
    const client = toAdminClient({
      clientId: 'c',
      tenantId: 't',
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
    } as never);
    expect(keys('AdminClientViewDto')).toEqual(Object.keys(client).sort());
    const cred = toAdminCredential(
      { clientId: 'c', version: 1, createdAt: new Date() },
      new Date(),
    );
    expect(keys('AdminCredentialViewDto')).toEqual(Object.keys(cred).sort());
    expect(keys('AdminResourceViewDto')).toEqual(
      Object.keys(
        toAdminResource({ resourceId: 'r', identifier: 'https://r/', scopes: [] }),
      ).sort(),
    );
    expect(keys('IssuedSecretViewDto')).toEqual(['clientId', 'clientSecret', 'version']);
    expect(keys('ClientPageViewDto')).toEqual(['items', 'nextCursor']);
    expect(keys('ResourcePageViewDto')).toEqual(['items', 'nextCursor']);
    expect(keys('CredentialListViewDto')).toEqual(['items']);
  });

  it('users/families/consents: mapper output keys == schema properties (run 47 Task 0)', () => {
    const now = new Date();
    expect(keys('AdminUserViewDto')).toEqual(
      Object.keys(
        toAdminUser(
          { sub: 'u', email: 'a@b.c', failedLoginCount: 0 } as never,
          { status: 'active', roles: [] },
          now,
        ),
      ).sort(),
    );
    expect(keys('AdminFamilyViewDto')).toEqual(
      Object.keys(
        toAdminFamily({
          familyId: 'f',
          clientId: 'c',
          resource: 'r',
          scope: [],
          createdAt: now,
          lastRotatedAt: now,
          expiresAt: now,
          active: true,
        } as never),
      ).sort(),
    );
    expect(keys('AdminConsentViewDto')).toEqual(
      Object.keys(
        toAdminConsent({
          _id: { toHexString: () => 'x' },
          clientId: 'c',
          resource: 'r',
          grantedScopes: [],
          grantedAt: now,
          updatedAt: now,
        } as never),
      ).sort(),
    );
    for (const page of ['UserPageViewDto', 'FamilyPageViewDto', 'ConsentPageViewDto']) {
      expect(keys(page)).toEqual(['items', 'nextCursor']);
      expect(schema(page).properties!.nextCursor).toMatchObject({ type: 'string', nullable: true });
    }
    const u = schema('AdminUserViewDto').properties as Record<string, Schema & { enum?: string[] }>;
    expect(u.membershipStatus.enum).toEqual(['active', 'suspended']);
    for (const f of ['lockedUntil', 'createdAt']) {
      expect(u[f]).toMatchObject({ type: 'string', format: 'date-time', nullable: true });
    }
    const f = schema('AdminFamilyViewDto').properties!;
    expect(f.revokedAt).toMatchObject({ type: 'string', format: 'date-time', nullable: true });
    expect(f.expiresAt.nullable).toBeUndefined();
    const c = schema('AdminConsentViewDto').properties!;
    for (const k of ['policyVersion', 'termsVersion']) {
      expect(c[k]).toMatchObject({ type: 'string', nullable: true });
    }
    expect(c.grantedAt.nullable).toBeUndefined();
  });

  it('dates are date-time strings, nullable fields carry a type', () => {
    const c = schema('AdminClientViewDto').properties!;
    for (const f of ['disabledAt', 'createdAt', 'updatedAt']) {
      expect(c[f]).toMatchObject({ type: 'string', format: 'date-time', nullable: true });
    }
    expect(c.frontchannelLogoutUri).toMatchObject({ type: 'string', nullable: true });
    expect(schema('ClientPageViewDto').properties!.nextCursor).toMatchObject({
      type: 'string',
      nullable: true,
    });
    const cr = schema('AdminCredentialViewDto').properties!;
    expect(cr.createdAt).toMatchObject({ type: 'string', format: 'date-time' });
    expect(cr.createdAt.nullable).toBeUndefined();
    expect(cr.expiresAt).toMatchObject({ type: 'string', format: 'date-time', nullable: true });
  });

  it('DEBT-294: UpdateClientDto.frontchannelLogoutUri is string | null', () => {
    expect(schema('UpdateClientDto').properties!.frontchannelLogoutUri).toMatchObject({
      type: 'string',
      nullable: true,
    });
  });

  it('clients/secrets/resources operations reference the view schemas', () => {
    const r = (n: string) => `#/components/schemas/${n}`;
    expect(ref('/admin/clients', 'get', '200')).toBe(r('ClientPageViewDto'));
    expect(ref('/admin/clients', 'post', '201')).toBe(r('AdminClientViewDto'));
    expect(ref('/admin/clients/{clientId}', 'get', '200')).toBe(r('AdminClientViewDto'));
    expect(ref('/admin/clients/{clientId}', 'patch', '200')).toBe(r('AdminClientViewDto'));
    expect(ref('/admin/clients/{clientId}/secrets', 'get', '200')).toBe(r('CredentialListViewDto'));
    expect(ref('/admin/clients/{clientId}/secrets', 'post', '201')).toBe(r('IssuedSecretViewDto'));
    expect(
      Object.keys(
        (doc.paths['/admin/clients/{clientId}/secrets/{version}'] as Record<string, never>).delete[
          'responses'
        ],
      ),
    ).toEqual(['204']);
    expect(ref('/admin/resources', 'get', '200')).toBe(r('ResourcePageViewDto'));
    expect(ref('/admin/resources', 'post', '201')).toBe(r('AdminResourceViewDto'));
    expect(ref('/admin/resources/{resourceId}', 'get', '200')).toBe(r('AdminResourceViewDto'));
    expect(ref('/admin/resources/{resourceId}', 'patch', '200')).toBe(r('AdminResourceViewDto'));
  });

  it('users operations reference the view schemas; 204 operations have no body (run 47 Task 0)', () => {
    const r = (n: string) => `#/components/schemas/${n}`;
    expect(ref('/admin/users', 'get', '200')).toBe(r('UserPageViewDto'));
    expect(ref('/admin/users/{id}', 'get', '200')).toBe(r('AdminUserViewDto'));
    expect(ref('/admin/users/{id}/lock', 'post', '200')).toBe(r('AdminUserViewDto'));
    expect(ref('/admin/users/{id}/unlock', 'post', '200')).toBe(r('AdminUserViewDto'));
    expect(ref('/admin/users/{id}/roles', 'patch', '200')).toBe(r('AdminUserViewDto'));
    expect(ref('/admin/users/{id}/families', 'get', '200')).toBe(r('FamilyPageViewDto'));
    expect(ref('/admin/users/{id}/consents', 'get', '200')).toBe(r('ConsentPageViewDto'));
    const responses = (path: string, method: string) =>
      (doc.paths[path] as Record<string, { responses: Record<string, { content?: unknown }> }>)[
        method
      ].responses;
    for (const [path, method] of [
      ['/admin/users/{id}/sessions/revoke', 'post'],
      ['/admin/users/{id}/families/{familyId}/revoke', 'post'],
      ['/admin/users/{id}/consents/{consentId}', 'delete'],
    ]) {
      const res = responses(path, method);
      expect(Object.keys(res)).toEqual(['204']);
      expect(res['204'].content).toBeUndefined();
    }
  });

  it('audit: mapper keys == schema properties, enums, optional fields, $ref (run 48 Task 0)', () => {
    const view = toAdminAuditEvent({
      eventId: 'e',
      timestamp: new Date(),
      actorType: 'admin',
      actorId: 'a',
      tenantId: 't',
      action: AuditAction.TOKEN_REUSE_DETECTED,
      targetType: 'user',
      targetId: 'u',
      clientId: 'c',
      ip: '127.0.0.1',
      userAgent: 'ua',
      requestId: 'r',
      result: 'failure',
      reason: 'x',
      metadata: { familyId: 'f', count: 1 },
    });
    expect(keys('AdminAuditEventViewDto')).toEqual(Object.keys(view).sort());
    expect(keys('AuditPageViewDto')).toEqual(['items', 'nextCursor']);
    expect(schema('AuditPageViewDto').properties!.nextCursor).toMatchObject({
      type: 'string',
      nullable: true,
    });
    const s = schema('AdminAuditEventViewDto') as Schema & { required?: string[] };
    expect([...(s.required ?? [])].sort()).toEqual(
      ['action', 'actorType', 'eventId', 'result', 'timestamp'].sort(),
    );
    const p = s.properties as Record<
      string,
      Schema & { enum?: string[]; additionalProperties?: unknown }
    >;
    expect(p.actorType.enum).toEqual(['user', 'client', 'admin', 'system']);
    expect(p.result.enum).toEqual(['success', 'failure']);
    expect([...p.action.enum!].sort()).toEqual([...Object.values(AuditAction)].sort());
    expect(p.timestamp).toMatchObject({ type: 'string', format: 'date-time' });
    expect(p.metadata).toMatchObject({
      type: 'object',
      additionalProperties: {
        oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
        nullable: true,
      },
    });
    expect(ref('/admin/audit', 'get', '200')).toBe('#/components/schemas/AuditPageViewDto');
  });
});
