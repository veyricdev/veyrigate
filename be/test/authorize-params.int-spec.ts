import { jest } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import type { Model } from 'mongoose';
import { join } from 'node:path';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { AuthorizeController } from '../src/modules/oauth/authorize/authorize.controller';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import { AuthorizeService } from '../src/modules/oauth/authorize/authorize.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { ConsentService } from '../src/modules/oauth/consent/consent.service';
import { ResourceService } from '../src/modules/resources/resource.service';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { SESSION_COOKIE, SessionCookie } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { seedOAuthUser } from './oauth-fixtures';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-authparams-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `ap${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const CLIENT = `${RUN}-client`;
const REDIRECT = 'https://app.example.com/callback';
const REDIRECT_2 = 'https://app.example.com/callback2';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const cfg = {
  getOrThrow: (ns: string) => {
    if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
    if (ns === 'session') return { cookieSecure: false };
    if (ns === 'token')
      return { accessTokenTtl: 900, sessionIdleTtl: 3600, sessionAbsoluteTtl: 86400 };
    if (ns === 'security') return { csrfSecret: 'test-csrf-secret' };
    if (ns === 'consent') return { policyVersion: '1', termsVersion: '1' };
    throw new Error(`Unexpected config namespace: ${ns}`);
  },
} as unknown as ConfigService;

/** A valid query (Phase 1 + Phase 2), plus `extra` raw pairs appended (to repeat a parameter). */
function query(extra: [string, string][] = [], omit: string[] = []): string {
  const pairs: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', CLIENT],
    ['redirect_uri', REDIRECT],
    ['scope', 'openid profile'],
    ['state', 'rp-state'],
    ['nonce', 'rp-nonce'],
    ['code_challenge', CHALLENGE],
    ['code_challenge_method', 'S256'],
  ];
  const kept = pairs.filter(([k]) => !omit.includes(k));
  return `/authorize?${new URLSearchParams([...kept, ...extra]).toString()}`;
}

// DEBT-204/205 (run 35, Task 1): a repeated recognised OAuth parameter at /authorize.
describe('/authorize repeated parameters (DEBT-204/205, RFC 6749 §3.1)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let sessions: SessionService;
  let sessionId = '';

  const get = (url: string, signedIn = true) =>
    app.inject({
      method: 'GET',
      url,
      cookies: signedIn ? { [SESSION_COOKIE]: sessionId } : {},
    });
  const countKeys = async () =>
    (await redis.keys('authz_code:*')).length + (await redis.keys('authz_ctx:*')).length;

  /** 302 to the trusted redirect_uri with `invalid_request` + iss. */
  const expectInvalidRequest = (res: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers['location'] as string);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('error_description')).toBe('Repeated parameter.');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
    expect(loc.searchParams.get('code')).toBeNull();
    return loc;
  };

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      controllers: [AuthorizeController],
      providers: [
        AuthorizeService,
        AuthorizeRequestContextService,
        AuthorizationCodeService,
        ConsentService,
        CsrfService,
        CsrfGuard,
        ClientService,
        ResourceService,
        SessionService,
        SessionCookie,
        AuditService,
        UserTenantService,
        HtmlExceptionFilter,
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(cookie);
    await app.register(view, {
      engine: { eta: new Eta({ views: join(process.cwd(), 'src/views'), autoEscape: true }) },
      root: join(process.cwd(), 'src/views'),
      layout: 'layout.eta',
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const clientModel = app.get<Model<Client>>(getModelToken('Client'));
    await syncAllIndexes(clientModel.db);
    await new ClientService(clientModel, cfg).create({
      clientId: CLIENT,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [REDIRECT, REDIRECT_2],
      allowedResources: [],
      scopes: ['openid', 'profile'],
      tenantId: 'tenant-A',
    });
    sessions = app.get(SessionService);
    const userId = await seedOAuthUser(clientModel.db, { tenantId: 'tenant-A' });
    sessionId = (await sessions.create(userId, 'tenant-A')).id;
  }, 30_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (app) {
      await app.get<Model<Client>>(getModelToken('Client')).db.dropDatabase();
      await app.close();
    }
  });

  it('control: the same request without repetition => 200 consent screen', async () => {
    const res = await get(query());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Authorize access');
  });

  it('scope=a&scope=b => 302 invalid_request with the original state + iss (no 500)', async () => {
    const loc = expectInvalidRequest(await get(query([['scope', 'profile']])));
    expect(loc.searchParams.get('state')).toBe('rp-state');
  });

  it('prompt=login&prompt=none => 302 invalid_request (no 500)', async () => {
    const res = await get(
      query([
        ['prompt', 'login'],
        ['prompt', 'none'],
      ]),
    );
    expect(expectInvalidRequest(res).searchParams.get('state')).toBe('rp-state');
  });

  it('nonce repeated => 302 invalid_request; no code and no context written', async () => {
    const before = await countKeys();
    expectInvalidRequest(await get(query([['nonce', 'other-nonce']])));
    expect(await countKeys()).toBe(before);
  });

  it('nonce repeated without a session => 302 invalid_request, no login context written', async () => {
    const before = await countKeys();
    expectInvalidRequest(await get(query([['nonce', 'other-nonce']]), false));
    expect(await countKeys()).toBe(before);
  });

  it('state=a&state=b => 302 invalid_request WITHOUT any state parameter', async () => {
    const loc = expectInvalidRequest(await get(query([['state', 'second-state']])));
    expect(loc.searchParams.has('state')).toBe(false);
  });

  it.each([
    ['code_challenge', [CHALLENGE]],
    ['code_challenge_method', ['S256']],
    ['response_type', ['code']],
    // Not in the base query: send it twice.
    ['max_age', ['60', '60']],
  ])('%s repeated => 302 invalid_request', async (key, values) => {
    const before = await countKeys();
    expectInvalidRequest(await get(query(values.map((v): [string, string] => [key, v]))));
    expect(await countKeys()).toBe(before);
  });

  it('client_id repeated => 400 error page, no Location, never looked up with an array', async () => {
    const lookup = jest.spyOn(app.get(ClientService), 'findByClientId');
    const res = await get(query([['client_id', `${RUN}-other`]]));
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('redirect_uri repeated (both registered) => 400 error page, no Location', async () => {
    const res = await get(query([['redirect_uri', REDIRECT_2]]));
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
  });

  it('request_id repeated => 400 error page, the context store is never consumed', async () => {
    const consume = jest.spyOn(app.get(AuthorizeRequestContextService), 'consume');
    const res = await get('/authorize?request_id=a&request_id=b');
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(consume).not.toHaveBeenCalled();
  });

  it('resource repeated keeps invalid_target (INV-15, RFC 8707 §2)', async () => {
    const res = await get(
      query([
        ['resource', 'https://a.example.com/'],
        ['resource', 'https://b.example.com/'],
      ]),
    );
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers['location'] as string);
    expect(loc.searchParams.get('error')).toBe('invalid_target');
  });

  it('an unrecognised parameter repeated (utm) is ignored => normal flow (200 consent)', async () => {
    const res = await get(
      query([
        ['utm', '1'],
        ['utm', '2'],
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Authorize access');
  });

  // Tester (run 35): EVERY recognised parameter x each repetition shape Fastify can produce. Empty
  // values still arrive as an array (`k=&k=`); bracket keys (`k[]=`, `k[0]=`) are NOT parsed into
  // the recognised key by Fastify's query parser, so they must be ignored like any unknown key.
  describe('every recognised parameter x repetition shape (tester run 35)', () => {
    const sample: Record<string, string> = {
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      scope: 'openid profile',
      resource: 'https://a.example.com/',
      state: 'rp-state',
      nonce: 'rp-nonce',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      prompt: 'none',
      max_age: '60',
      request_id: 'some-request-id',
    };
    const KEYS = Object.keys(sample);
    const shapes: [string, (k: string) => [string, string][]][] = [
      [
        'k=&k= (both empty)',
        (k) => [
          [k, ''],
          [k, ''],
        ],
      ],
      [
        'k=<valid>&k= (valid + empty)',
        (k) => [
          [k, sample[k]],
          [k, ''],
        ],
      ],
      [
        'k=&k=<valid> (empty + valid)',
        (k) => [
          [k, ''],
          [k, sample[k]],
        ],
      ],
    ];
    const cases = KEYS.flatMap((k) => shapes.map(([shape, make]) => [k, shape, make(k)] as const));

    it('covers all 12 recognised keys', () => {
      expect([...KEYS].sort()).toEqual(
        [
          'response_type',
          'client_id',
          'redirect_uri',
          'scope',
          'resource',
          'state',
          'nonce',
          'code_challenge',
          'code_challenge_method',
          'prompt',
          'max_age',
          'request_id',
        ].sort(),
      );
    });

    it.each(cases)(
      '%s repeated as %s => refused per trust phase, nothing written',
      async (key, _s, pairs) => {
        const lookup = jest.spyOn(app.get(ClientService), 'findByClientId');
        const consume = jest.spyOn(app.get(AuthorizeRequestContextService), 'consume');
        const before = await countKeys();
        const res = await get(query([...pairs], [key]));
        expect(res.statusCode).not.toBe(500);
        if (key === 'client_id' || key === 'redirect_uri' || key === 'request_id') {
          // No trusted redirect_uri: first-party 400 page, never a redirect, never an array lookup.
          expect(res.statusCode).toBe(400);
          expect(res.headers['location']).toBeUndefined();
          expect(lookup).not.toHaveBeenCalled();
          expect(consume).not.toHaveBeenCalled();
        } else if (key === 'resource') {
          expect(res.statusCode).toBe(302);
          const loc = new URL(res.headers['location'] as string);
          expect(loc.searchParams.get('error')).toBe('invalid_target');
          expect(loc.searchParams.get('code')).toBeNull();
        } else {
          const loc = expectInvalidRequest(res);
          if (key === 'state') expect(loc.searchParams.has('state')).toBe(false);
          else expect(loc.searchParams.get('state')).toBe('rp-state');
        }
        for (const call of lookup.mock.calls) expect(typeof call[0]).toBe('string');
        expect(await countKeys()).toBe(before);
      },
    );

    it.each(KEYS.flatMap((k) => [`${k}[]`, `${k}[0]`]))(
      'bracket key %s is an unrecognised parameter => ignored, normal flow (200 consent)',
      async (bracket) => {
        const key = bracket.replace(/\[0?\]$/, '');
        const lookup = jest.spyOn(app.get(ClientService), 'findByClientId');
        const res = await get(
          query([
            [bracket, sample[key]],
            [bracket, 'second'],
          ]),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('Authorize access');
        for (const call of lookup.mock.calls) expect(call[0]).toBe(CLIENT);
      },
    );
  });
});
