import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import mongoose, { type Connection } from 'mongoose';
import { MongoService } from '../src/database/mongo/mongo.service';
import { dropIntDb } from './int-hooks';

/**
 * Run 79 tester (DEBT-483): the boot-time transaction check against the REAL `hello` of vg-test-mongo
 * (replica set rs0) through Nest's lifecycle (`init()` runs `onApplicationBootstrap`). The unit spec
 * uses hand-written `hello` objects; here the positive case is the real server reply, and
 * "standalone" is that same real reply with the replica-set fields removed.
 */
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-r79-${Date.now()}?directConnection=true`;
const MESSAGE = 'MongoDB must be a replica set (or mongos): transactions are required (DEBT-483)';
const HOST = new URL(MONGO_URI.replace(/^mongodb(\+srv)?:/, 'http:')).host;

describe('run 79 tester: Mongo transaction boot check on a real server (DEBT-483)', () => {
  let ref: TestingModule | undefined;
  let warn: ReturnType<typeof jest.spyOn>;
  let error: ReturnType<typeof jest.spyOn>;

  const compile = (nodeEnv: string) =>
    Test.createTestingModule({
      imports: [MongooseModule.forRoot(MONGO_URI, { serverSelectionTimeoutMS: 5000 })],
      providers: [
        MongoService,
        { provide: ConfigService, useValue: { getOrThrow: () => ({ nodeEnv }) } },
      ],
    }).compile();

  /** Make the real `hello` reply look like a standalone server (setName/hosts/primary removed). */
  const asStandalone = (conn: Connection) => {
    const realAdmin = conn.db!.admin.bind(conn.db!);
    jest.spyOn(conn.db!, 'admin').mockImplementation(() => {
      const admin = realAdmin();
      return {
        command: async (cmd: Record<string, unknown>) => {
          const hello = (await admin.command(cmd)) as Record<string, unknown>;
          expect(hello.setName).toBe('rs0'); // the real server IS a replica set
          const standalone = { ...hello };
          for (const k of ['setName', 'hosts', 'primary', 'setVersion']) delete standalone[k];
          return standalone;
        },
        ping: admin.ping.bind(admin),
      } as unknown as ReturnType<typeof realAdmin>;
    });
  };

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn');
    error = jest.spyOn(Logger.prototype, 'error');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    // An init() that rejected leaves the Mongoose connection open: close it explicitly.
    await ref
      ?.get<Connection>(getConnectionToken())
      .close()
      .catch(() => undefined);
    await ref?.close().catch(() => undefined);
    ref = undefined;
  });
  afterAll(async () => {
    await dropIntDb(MONGO_URI).catch(() => undefined);
  });

  it('production + the real rs0 hello => boots, no WARN/ERROR from MongoService', async () => {
    ref = await compile('production');
    await expect(ref.init()).resolves.toBeDefined();
    const ours = (spy: typeof warn) =>
      spy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('DEBT-483'));
    expect(ours(warn)).toHaveLength(0);
    expect(ours(error)).toHaveLength(0);
    expect(await ref.get(MongoService).ping()).toBe(true);
  });

  it('production + real hello stripped to standalone => init rejects with the fixed message (no URI/host)', async () => {
    ref = await compile('production');
    asStandalone(ref.get<Connection>(getConnectionToken()));
    const err = (await ref.init().then(
      () => new Error('booted'),
      (e: Error) => e,
    )) as Error;
    expect(err.message).toBe(MESSAGE);
    expect(err.message).not.toContain(HOST);
    expect(err.message).not.toContain('mongodb://');
    expect(err.cause).toBeUndefined();
  });

  it('development + real hello stripped to standalone => boots with exactly one WARN', async () => {
    ref = await compile('development');
    asStandalone(ref.get<Connection>(getConnectionToken()));
    await expect(ref.init()).resolves.toBeDefined();
    const ours = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('DEBT-483'));
    expect(ours).toHaveLength(1);
    expect(String(ours[0][0])).not.toContain(HOST);
  });

  it('production + a real driver error on hello (credentialed URI, closed port) => fixed message, no cause, logs carry no secret', async () => {
    const secret = 'r79-S3CRET';
    // A raw driver client (auto-connect on first command) so the error is the driver's own
    // server-selection failure, not a mongoose "connection closed".
    const dead = new mongoose.mongo.MongoClient(`mongodb://u:${secret}@127.0.0.1:1/x`, {
      serverSelectionTimeoutMS: 800,
    });
    try {
      const connection = { db: dead.db('x') } as unknown as Connection;
      const config = { getOrThrow: () => ({ nodeEnv: 'production' }) } as unknown as ConfigService;
      const err = (await new MongoService(connection, config).onApplicationBootstrap().then(
        () => new Error('booted'),
        (e: Error) => e,
      )) as Error;
      expect(err.message).toBe(`${MESSAGE} — could not read the server topology`);
      expect(err.cause).toBeUndefined();
      const logged = JSON.stringify(
        error.mock.calls.filter((c: unknown[]) => String(c[0]).includes('DEBT-483')),
      );
      expect(logged).toContain('could not read the server topology');
      expect(logged).toContain('127.0.0.1:1'); // the real driver diagnostic survives
      expect(logged).not.toContain(secret);
    } finally {
      await dead.close().catch(() => undefined);
    }
  }, 20_000);
});
