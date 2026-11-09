import IORedis from 'ioredis';
import mongoose from 'mongoose';
import { scrubUriCredentials } from '../src/common/logger/error-log';
import { cliErrorText } from '../src/database/mongo/sync-indexes';

/**
 * Run 78 tester (DEBT-254/523/525): scrub the REAL error messages of the Mongo / Redis drivers (unit
 * specs use hand-written strings). Targets are a closed local port, an `.invalid` SRV name and the
 * vg-test-mongo container with wrong credentials — never a dev DB. Invariant: the secret never
 * survives `cliErrorText` / `scrubUriCredentials`, and the diagnostic part (ECONNREFUSED host:port,
 * "Authentication failed") is kept so the operator still sees why it failed.
 */
const SECRET = 'r78-S3CRETX';
const TEST_MONGO_PORT =
  new URL(process.env.TEST_MONGO_URI ?? 'mongodb://localhost:27117/x').port || '27117';

const mongoError = async (uri: string): Promise<Error> => {
  const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 800 });
  try {
    await conn.asPromise();
  } catch (err) {
    // Jest's ESM VM realm: a Node-core error (the SRV `querySrv` DNS error) is not `instanceof` the
    // test realm's Error. The built CLI runs in one realm (checked by hand: it prints
    // `querySrv ECONNREFUSED _mongodb._tcp.nohost.invalid`), so re-wrap the message here.
    return err instanceof Error ? err : new Error((err as Error).message);
  } finally {
    await conn.close().catch(() => undefined);
  }
  throw new Error(`expected a connection error for case ${uri.length}`);
};

describe('run 78 tester: scrub real driver error messages', () => {
  it.each([
    ['closed port', `mongodb://u:${SECRET}@127.0.0.1:1/x`, 'ECONNREFUSED 127.0.0.1:1'],
    ['unescaped / in password', `mongodb://u:p/s${SECRET}@127.0.0.1:1/x`, 'unescaped'],
    ['raw @ in password', `mongodb://u:p@s${SECRET}@127.0.0.1:1/x`, 'Invalid connection string'],
    ['srv on an unresolvable name', `mongodb+srv://u:${SECRET}@nohost.invalid/x`, '_mongodb._tcp'],
    ['bad host:port', `mongodb://u:${SECRET}@127.0.0.1:1:2/x`, 'Unable to parse'],
    [
      'auth failure on vg-test-mongo',
      `mongodb://u:${SECRET}@127.0.0.1:${TEST_MONGO_PORT}/x?directConnection=true&authSource=admin`,
      'Authentication failed',
    ],
  ])(
    'Mongo %s ⇒ no secret, diagnostic kept',
    async (_n, uri, diagnostic) => {
      const err = await mongoError(uri);
      const cli = cliErrorText(err, uri);
      const log = scrubUriCredentials(err.message);
      for (const text of [cli, log]) {
        expect(text).not.toContain(SECRET);
        expect(text).toContain(diagnostic);
      }
      // A driver that DID echo the full URI (defence in depth): the literal is replaced.
      const echoed = new Error(`${err.message} (uri ${uri})`);
      expect(cliErrorText(echoed, uri)).not.toContain(SECRET);
      expect(cliErrorText(echoed, uri)).toContain('[MONGO_URI]');
    },
    20_000,
  );

  it('Redis: error event + rejected command on a closed port ⇒ no secret, ECONNREFUSED kept', async () => {
    const url = `redis://u:${SECRET}@127.0.0.1:1`;
    const client = new IORedis(url, { maxRetriesPerRequest: 0, retryStrategy: () => null });
    const events: string[] = [];
    client.on('error', (e: Error) => events.push(e.message));
    let rejected: string;
    try {
      rejected = await client.ping().then(
        () => 'connected?',
        (e: Error) => e.message,
      );
    } finally {
      client.disconnect();
    }
    const messages = [...events, rejected];
    expect(messages.join('\n')).toContain('ECONNREFUSED 127.0.0.1:1');
    for (const m of messages) {
      const scrubbed = scrubUriCredentials(`Redis error: ${m} (${url})`);
      expect(scrubbed).not.toContain(SECRET);
    }
  });

  it('a driver message > 2 KB that ends inside a credentialed URI ⇒ cut before it, no secret, linear time', () => {
    const uri = `mongodb://u:${SECRET}@127.0.0.1:1/x`;
    const long = `${'connect ECONNREFUSED 127.0.0.1:1 '.repeat(62)}${uri}`;
    expect(long.length).toBeGreaterThan(2048);
    const started = performance.now();
    const out = scrubUriCredentials(long);
    expect(performance.now() - started).toBeLessThan(50);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('ECONNREFUSED 127.0.0.1:1');
  });
});
