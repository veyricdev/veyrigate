import { mongoTarget } from './sync-indexes';

/** F5 (run 40): the CLIs print the database they are about to write, never its credentials. */
describe('mongoTarget (run 40 F5)', () => {
  it('prints host/db of a plain URI, without the query string', () => {
    expect(mongoTarget('mongodb://localhost:27117/vg-drill-src-1?directConnection=true')).toBe(
      'target: localhost:27117/vg-drill-src-1',
    );
  });

  it('drops user:password@ (incl. an encoded @ in the password) and keeps every host', () => {
    const line = mongoTarget(
      'mongodb://admin:S3cr%40tPw@db1.internal:27017,db2.internal:27017/sso-idp?replicaSet=rs0&authSource=admin',
    );
    expect(line).toBe('target: db1.internal:27017,db2.internal:27017/sso-idp');
    expect(line).not.toMatch(/admin:|S3cr|%40|authSource/);
  });

  it('handles mongodb+srv and a user without password', () => {
    expect(mongoTarget('mongodb+srv://svc@cluster0.example.net/sso-prod')).toBe(
      'target: cluster0.example.net/sso-prod',
    );
  });

  it('names the driver default db when the URI has none', () => {
    expect(mongoTarget('mongodb://localhost:27017')).toBe('target: localhost:27017/test (default)');
    expect(mongoTarget('mongodb://localhost:27017/?directConnection=true')).toBe(
      'target: localhost:27017/test (default)',
    );
  });

  it('handles IPv6 hosts and an encoded : in the password', () => {
    const line = mongoTarget('mongodb://u:p%3Aw@[::1]:27017,[fe80::2]:27018/sso?tls=true');
    expect(line).toBe('target: [::1]:27017,[fe80::2]:27018/sso');
    expect(line).not.toMatch(/u:|p%3Aw|tls/);
  });

  // Retry 1 (senior 🔴1): unencoded `/ ? #` in the password used to leak user + password.
  it.each([
    ['mongodb://u:p/ss@h:1/db', /u:|p\/ss/],
    ['mongodb://u:p?x@h/db', /u:|p\?x/],
    ['mongodb://u:p#x@h/db', /u:|p#x/],
    ['mongodb://user/x:pw@h', /user|pw/],
    ['mongodb+srv://u:a/b?c@cluster0.example.net/sso', /u:|a\/b/],
    ['mongodb://h:1/db@x', /@/],
  ])('fails closed on %s instead of echoing credentials', (uri, leak) => {
    const line = mongoTarget(uri);
    expect(line).toBe('target: (unparseable MONGO_URI)');
    expect(line).not.toMatch(leak);
  });

  // Retry 2 (senior lượt 2 🔴1): `user:<digits>` before an unencoded `? #` looks like `host:port`.
  it.each([
    ['mongodb://u:12345?x@h/db', /u:|12345/],
    ['mongodb://admin:2024?Secret@h/sso', /admin|2024|Secret/],
    ['mongodb://u:1234#@h/db', /u:|1234/],
    ['mongodb://u:12345/?x@h/db', /u:|12345/],
    ['mongodb://h:1,u:123?x@h2/db', /u:|123/],
    ['mongodb+srv://u:99#x@cluster0.example.net/sso', /u:|99/],
  ])('fails closed on digit-leading password %s', (uri, leak) => {
    const line = mongoTarget(uri);
    expect(line).toBe('target: (unparseable MONGO_URI)');
    expect(line).not.toMatch(leak);
  });

  it('never prints a random password with raw / ? # : @ (seeded property test)', () => {
    let seed = 40;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const alphabet = '0123456789/?#:@abcXYZ';
    for (let i = 0; i < 2000; i++) {
      let pw = String(rand(100000));
      for (let k = rand(8); k > 0; k--) pw += alphabet[rand(alphabet.length)];
      const user = `usr${i}`;
      const host = rand(3) ? `h:${rand(65535)}` : 'h';
      const uri = `mongodb://${user}:${pw}@${host}/db${i}${i % 2 ? '?tls=true' : ''}`;
      // Either the exact host/db, or fail closed — nothing else (so no user/password fragment).
      expect(['target: (unparseable MONGO_URI)', `target: ${host}/db${i}`]).toContain(
        mongoTarget(uri),
      );
    }
  });

  it('never echoes an unparseable value (it may be a secret pasted in the wrong variable)', () => {
    expect(mongoTarget('p4ssw0rd-not-a-uri')).toBe('target: (unparseable MONGO_URI)');
  });
});
