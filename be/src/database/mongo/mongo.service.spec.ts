import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Connection } from 'mongoose';
import { MongoService, supportsTransactions } from './mongo.service';

const MESSAGE = 'MongoDB must be a replica set (or mongos): transactions are required (DEBT-483)';

/** DEBT-483: refuse to boot in production on a Mongo that cannot run transactions. */
describe('MongoService transaction support check (DEBT-483)', () => {
  const make = (nodeEnv: string, command: () => Promise<unknown>) => {
    const connection = {
      db: { admin: () => ({ command, ping: async () => ({ ok: 1 }) }) },
    } as unknown as Connection;
    const config = { getOrThrow: () => ({ nodeEnv }) } as unknown as ConfigService;
    return new MongoService(connection, config);
  };
  let warn: ReturnType<typeof jest.spyOn>;
  let error: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('supportsTransactions: replica set member or mongos only', () => {
    expect(supportsTransactions({ setName: 'rs0' })).toBe(true);
    expect(supportsTransactions({ msg: 'isdbgrid' })).toBe(true);
    expect(supportsTransactions({})).toBe(false);
    expect(supportsTransactions({ setName: '' })).toBe(false);
    expect(supportsTransactions({ setName: 1 })).toBe(false);
    expect(supportsTransactions({ msg: 'other' })).toBe(false);
  });

  it('production + standalone => boot rejects with the fixed message', async () => {
    const svc = make('production', async () => ({ ok: 1, isWritablePrimary: true }));
    await expect(svc.onApplicationBootstrap()).rejects.toThrow(MESSAGE);
  });

  it('production + replica set / mongos => boots, no log', async () => {
    await expect(
      make('production', async () => ({ ok: 1, setName: 'rs0' })).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
    await expect(
      make('production', async () => ({ ok: 1, msg: 'isdbgrid' })).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('development + standalone => boots with exactly one WARN', async () => {
    const svc = make('development', async () => ({ ok: 1 }));
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(MESSAGE);
  });

  it('production + hello fails => rejects with a fixed message (no cause), logs scrubbed', async () => {
    const svc = make('production', async () => {
      throw new Error('connect failed mongodb://u:s3cret@h:27017/db');
    });
    const err = (await svc.onApplicationBootstrap().catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('s3cret');
    expect(err.cause).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify([...error.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain('s3cret');
  });

  it('development + hello fails => boots with one scrubbed WARN', async () => {
    const svc = make('development', async () => {
      throw new Error('connect failed mongodb://u:s3cret@h:27017/db');
    });
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('s3cret');
  });
});
