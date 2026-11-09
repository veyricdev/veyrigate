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

  it('DEBT-523: a decoded password holding @ is scrubbed up to the LAST @ before the host', () => {
    const out = scrubUriCredentials('connect mongodb://u:p@ss@word@h1:27017,h2/db failed; a@b.c');
    expect(out).toBe('connect mongodb://[redacted]@h1:27017,h2/db failed; a@b.c');
    expect(out).not.toMatch(/ss@|word/);
  });

  it('DEBT-523: masks secret-looking query/option values, keeps the rest', () => {
    const out = scrubUriCredentials(
      'mongodb://h/db?tls=true&tlsCertificateKeyFilePassword=kfpw1&authMechanismProperties=AWS_SESSION_TOKEN:tok2,X:y&replicaSet=rs0 password=pw3 apiKey=k4 client_secret=s5',
    );
    expect(out).not.toMatch(/kfpw1|tok2|pw3|k4|s5/);
    expect(out).toContain('tls=true');
    expect(out).toContain('replicaSet=rs0');
    expect(out).toContain('tlsCertificateKeyFilePassword=[redacted]');
    expect(out).toContain('password=[redacted]');
  });

  it('leaves a message without credentials unchanged', () => {
    expect(scrubUriCredentials('connect ECONNREFUSED 127.0.0.1:27017')).toBe(
      'connect ECONNREFUSED 127.0.0.1:27017',
    );
  });

  it('DEBT-525: masks a key whose value holds more key=value pairs', () => {
    const out = scrubUriCredentials('opts=a=b=password=pw9 x=1');
    expect(out).not.toContain('pw9');
    expect(out).toContain('x=1');
  });

  // DEBT-525: runs on the app event loop (redis/mongo error handlers, health), so a long or hostile
  // driver message must not block it.
  it.each([
    ['key. x 2500 (10 KB)', 'key.'.repeat(2_500)],
    ['key. x 5000 (20 KB)', 'key.'.repeat(5_000)],
    ['key. x 25000 (100 KB)', 'key.'.repeat(25_000)],
    ['a x 20000 (20 KB)', 'a'.repeat(20_000)],
    ['a x 100000 (100 KB)', 'a'.repeat(100_000)],
    ['a:// x 25000 (100 KB)', 'a://'.repeat(25_000)],
    ['k= x 50000 (100 KB)', 'k='.repeat(50_000)],
  ])('DEBT-525: hostile input %s finishes under 50 ms', (_name, input) => {
    const start = performance.now();
    scrubUriCredentials(input);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('DEBT-525: a long message is cut but a credential at its head is still scrubbed', () => {
    const out = scrubUriCredentials(
      `mongodb://admin:S3cr3tPw@db:27017/sso?password=pw7 ${'x'.repeat(100_000)}`,
    );
    expect(out).not.toMatch(/S3cr3tPw|pw7/);
    expect(out.startsWith('mongodb://[redacted]@db:27017/sso?password=[redacted] ')).toBe(true);
    expect(out.endsWith('[truncated]')).toBe(true);
    expect(out.length).toBeLessThan(2_100);
  });

  it('DEBT-525: a URI cut before its @ never leaks the partial userinfo', () => {
    const out = scrubUriCredentials(`${'y '.repeat(1_015)}mongodb://admin:S3cr3tPw@db:27017/sso`);
    expect(out).not.toMatch(/S3cr3tPw|admin:/);
    expect(out.endsWith('[truncated]')).toBe(true);
  });
});
