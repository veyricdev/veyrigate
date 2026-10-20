import { describe, expect, it } from '@jest/globals';
import { errorForLog, scrubUriCredentials } from './error-log';

describe('errorForLog (B7.4)', () => {
  it('keeps name, code and frames but never the message (E11000 dup key email)', () => {
    const err = Object.assign(
      new Error(
        'E11000 duplicate key error collection: x.users index: email_1 dup key: { email: "victim@example.com" }',
      ),
      { name: 'MongoServerError', code: 11000 },
    );
    const out = errorForLog(err);
    expect(out.split('\n')[0]).toBe('MongoServerError (code 11000)');
    expect(out).toMatch(/\n\s+at /);
    expect(out).not.toMatch(/victim@example\.com|dup key|E11000/);
  });

  it('drops a multi-line message too', () => {
    const out = errorForLog(new Error('first line\nsecret-token-123\nthird'));
    expect(out).not.toMatch(/first line|secret-token-123|third/);
    expect(out.startsWith('Error\n')).toBe(true);
  });

  it('drops a message line shaped like a stack frame (DEBT-235)', () => {
    const out = errorForLog(new Error('boom\n    at fake (framesecret-42)'));
    expect(out).not.toContain('framesecret-42');
    expect(out).toMatch(/\n\s+at /); // the real frames are still there
  });

  it('never stringifies a non-Error value', () => {
    expect(errorForLog('password=hunter2')).toBe('non-Error thrown (string)');
    expect(errorForLog({ token: 'x' })).toBe('non-Error thrown (object)');
  });
});

describe('scrubUriCredentials (B7.4)', () => {
  it('removes user:pass@ from mongo/redis URIs, keeps host', () => {
    const msg =
      'failed mongodb://admin:S3cr3tPw@db.internal:27017/sso and redis://:r3dispw@cache:6379/1';
    const out = scrubUriCredentials(msg);
    expect(out).not.toMatch(/S3cr3tPw|r3dispw|admin:/);
    expect(out).toContain('mongodb://[redacted]@db.internal:27017/sso');
    expect(out).toContain('redis://[redacted]@cache:6379/1');
  });

  it('leaves a message without credentials unchanged', () => {
    expect(scrubUriCredentials('connect ECONNREFUSED 127.0.0.1:27017')).toBe(
      'connect ECONNREFUSED 127.0.0.1:27017',
    );
  });
});
