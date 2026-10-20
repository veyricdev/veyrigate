import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Connection } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { buildPinoHttpOptions, LoggerModule } from '../src/common/logger/logger.module';
import { ConfigModule } from '../src/config/config.module';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { buildConfig } from '../src/config/configuration';
import { validateEnv } from '../src/config/validation.schema';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { MAILER, type MailMessage } from '../src/modules/mailer/mailer';
import { adminResourceIdentifier } from '../src/modules/oauth/token/token.service';
import { ResourceService } from '../src/modules/resources/resource.service';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';

/**
 * The REAL app for integration tests (run 38, B7.4): `AppModule` + `configureApp` exactly like
 * `main.ts`, so security headers, static assets and the pino logger are the production wiring.
 * Only three seams differ:
 * - config comes from the hermetic `env` below (never `be/.env`: `ignoreEnvFile`);
 * - mail goes to an in-memory outbox (never an SMTP server);
 * - pino writes to `logStream` (default: discarded) with the real `buildPinoHttpOptions`.
 * Mongo/Redis are the vg-test-* containers (own DB per spec, dropped on close).
 */
export interface FullApp {
  app: NestFastifyApplication;
  conn: Connection;
  outbox: MailMessage[];
  env: Record<string, string>;
  close(): Promise<void>;
}

export interface FullAppOptions {
  /** DB name suffix (`vg-int-<name>-<ts>`). */
  name: string;
  /** Extra/overriding env (e.g. `METRICS_TOKEN`). */
  env?: Record<string, string>;
  /** Where pino writes (one JSON line per entry). Default: discarded. */
  logStream?: Writable;
  /** Extra test seams (e.g. `overrideProvider` to force a 500). */
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export const FULL_APP_ISSUER = 'http://localhost:4000';

export async function bootFullApp(opts: FullAppOptions): Promise<FullApp> {
  const keyDir = await mkdtemp(join(tmpdir(), `vg-${opts.name}-keys-`));
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    ISSUER: FULL_APP_ISSUER,
    MONGO_URI:
      process.env.TEST_MONGO_URI ??
      `mongodb://localhost:27117/vg-int-${opts.name}-${Date.now()}?directConnection=true`,
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6479',
    ACCESS_TOKEN_TTL: '900',
    REFRESH_TOKEN_TTL: '2592000',
    SESSION_IDLE_TTL: '3600',
    SESSION_ABSOLUTE_TTL: '86400',
    SESSION_COOKIE_SECURE: 'false',
    KEY_PROVIDER: 'local',
    KEY_LOCAL_DIR: keyDir,
    SMTP_URL: 'smtp://127.0.0.1:9', // never used: MAILER is the in-memory outbox below
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    ADMIN_SEED_EMAIL: 'admin@fixture.test',
    CSRF_SECRET: 'full-app-csrf-secret-not-a-real-secret',
    RATE_LIMIT_WINDOW: '60',
    RATE_LIMIT_MAX: '100000',
    CLIENT_AUTH_FAIL_IP_MAX: '100000',
    CLIENT_AUTH_FAIL_CLIENT_MAX: '100000',
    ...opts.env,
  };

  @Global()
  @Module({
    imports: [
      NestConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => buildConfig(validateEnv(env))],
      }),
    ],
  })
  class TestConfigModule {}

  const sink =
    opts.logStream ??
    new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
  @Module({
    imports: [
      PinoLoggerModule.forRoot({ pinoHttp: [buildPinoHttpOptions(env.NODE_ENV) as never, sink] }),
    ],
  })
  class TestLoggerModule {}

  const outbox: MailMessage[] = [];
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideModule(ConfigModule)
    .useModule(TestConfigModule)
    .overrideModule(LoggerModule)
    .useModule(TestLoggerModule)
    .overrideProvider(MAILER)
    .useValue({ send: async (m: MailMessage) => void outbox.push(m) });
  if (opts.override) builder = opts.override(builder);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    bufferLogs: true,
  });
  // `configureApp` resolves `public/` + `views/` from `__dirname` (CJS in `dist/`). Jest runs the TS
  // sources as native ESM where `__dirname` does not exist, so expose `be/src` as that free
  // identifier only for the synchronous registration, then remove it again.
  const g = globalThis as { __dirname?: string };
  g.__dirname = join(process.cwd(), 'src');
  try {
    await configureApp(app);
  } finally {
    delete g.__dirname;
  }
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const conn = app.get<Connection>(getConnectionToken());
  await syncAllIndexes(conn);

  return {
    app,
    conn,
    outbox,
    env,
    close: async () => {
      if (!process.env.TEST_MONGO_URI) await conn.dropDatabase();
      await app.close();
      await rm(keyDir, { recursive: true, force: true });
    },
  };
}

// ---- Shared OAuth fixtures on the real app (B7.4 Task 3/4) ----

export const FLOW_REDIRECT = 'https://app.example.com/callback';
export const FLOW_API_AUD = 'https://api.example.com/';
export const FLOW_ADMIN_AUD = adminResourceIdentifier(FULL_APP_ISSUER);

export const basicAuth = (id: string, secret: string): string =>
  'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');

/** `api` + `admin` resources and one confidential (client_secret_basic) BFF in the default tenant. */
export async function seedFlowClient(full: FullApp): Promise<{ clientId: string; secret: string }> {
  const resources = full.app.get(ResourceService);
  await resources.create({ resourceId: 'api', identifier: FLOW_API_AUD, scopes: ['api.read'] });
  await resources.create({ resourceId: 'admin', identifier: FLOW_ADMIN_AUD });
  const clientId = `flow-bff-${randomUUID()}`;
  await full.app.get(ClientService).create({
    clientId,
    clientType: 'confidential',
    tokenEndpointAuthMethod: 'client_secret_basic',
    redirectUris: [FLOW_REDIRECT],
    allowedResources: ['api', 'admin'],
    scopes: ['openid', 'email', 'offline_access', 'api.read', 'admin.read', 'admin.write'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tenantId: DEFAULT_TENANT_ID,
  });
  const { secret } = await full.app.get(ClientCredentialService).createSecret(clientId);
  return { clientId, secret };
}

/** `GET /authorize` with a live session => the code from the 302 (PKCE S256). */
export async function authorizeCode(
  full: FullApp,
  p: { clientId: string; sessionId: string; resource: string; scope: string; verifier: string },
): Promise<string> {
  const res = await full.app.inject({
    method: 'GET',
    url: `/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: p.clientId,
      redirect_uri: FLOW_REDIRECT,
      scope: p.scope,
      resource: p.resource,
      state: 'rp-state',
      nonce: 'rp-nonce',
      code_challenge: deriveS256Challenge(p.verifier),
      code_challenge_method: 'S256',
    }).toString()}`,
    cookies: { [SESSION_COOKIE]: p.sessionId },
  });
  const location = String(res.headers['location'] ?? '');
  const code = location.startsWith(FLOW_REDIRECT)
    ? new URL(location).searchParams.get('code')
    : null;
  if (res.statusCode !== 302 || !code) {
    throw new Error(`authorize did not issue a code (status ${res.statusCode})`);
  }
  return code;
}

/** Form POST with client_secret_basic (`/token`, `/introspect`, `/revoke`). */
export interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  json<T = Record<string, unknown>>(): T;
}

export const formPost = (
  full: FullApp,
  url: string,
  auth: { clientId: string; secret: string },
  fields: Record<string, string>,
): Promise<InjectResponse> =>
  full.app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth(auth.clientId, auth.secret),
    },
    payload: new URLSearchParams(fields).toString(),
  });
