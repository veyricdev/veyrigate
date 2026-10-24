import {
  isDependencyUnavailable,
  isRedisUnavailable,
  KeyProviderUnavailableError,
} from './dependency-unavailable';

/** ioredis' class (not exported by the package): same shape — `name` getter = class name. */
class MaxRetriesPerRequestError extends Error {
  get name() {
    return this.constructor.name;
  }
}

/** Only the shapes observed in the run-53c kill test (runs/53c-B7.3/log.md), matched exactly. */
describe('isRedisUnavailable (run 53c)', () => {
  it.each([
    [
      'MaxRetriesPerRequestError',
      new MaxRetriesPerRequestError('Reached the max retries per request limit (which is 1).'),
    ],
    ['plain Error "Command timed out"', new Error('Command timed out')],
  ])('%s ⇒ unavailable', (_n, err) => {
    expect(isRedisUnavailable(err)).toBe(true);
    expect(isDependencyUnavailable(err)).toBe(true);
  });

  it.each([
    ['generic Error', new Error('redis down')],
    ['near miss message', new Error('Command timed out!')],
    ['subclass with the same message', new TypeError('Command timed out')],
    [
      'Mongo-like error',
      Object.assign(new Error('connection timed out'), { name: 'MongoNetworkTimeoutError' }),
    ],
    ['not observed: Connection is closed.', new Error('Connection is closed.')],
    ['a non-Error', { name: 'MaxRetriesPerRequestError', message: 'Command timed out' }],
    ['undefined', undefined],
  ])('%s ⇒ NOT unavailable (stays 500)', (_n, err) => {
    expect(isRedisUnavailable(err)).toBe(false);
    expect(isDependencyUnavailable(err)).toBe(false);
  });

  it('KeyProviderUnavailableError (DEBT-394) is a dependency outage, not a Redis one', () => {
    const err = new KeyProviderUnavailableError(new Error('vault read failed: status=503'));
    expect(isRedisUnavailable(err)).toBe(false);
    expect(isDependencyUnavailable(err)).toBe(true);
    expect(err.message).not.toContain('503'); // the cause is kept for logs, never the message
  });
});
