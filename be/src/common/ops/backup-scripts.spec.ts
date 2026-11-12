import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run 87 tester gate (DEBT-620): `ops/backup/mongo-backup.sh` counts documents from mongodump's own log, and
 * `mongo-restore.sh` checks mongorestore's summary line. Both are run here with fake mongodump / mongorestore /
 * mongosh / gpg (node scripts) that print REAL log lines captured from mongodump/mongorestore 100.20.1 (namespace in
 * backticks) and the older form without backticks. No Mongo, no gpg keys needed.
 */
const REPO = join(process.cwd(), '..');
const BACKUP = join(REPO, 'ops', 'backup', 'mongo-backup.sh');
const RESTORE = join(REPO, 'ops', 'backup', 'mongo-restore.sh');
const FPR = 'A'.repeat(40);
const fwd = (p: string) => p.replace(/\\/g, '/');

/** Captured from `mongodump --db=vg-drill-src --archive --gzip` (database-tools 100.20.1, 2026-11-12). */
const DUMP_100_20 = [
  '2026-11-12T07:03:53.748+0000\twriting `vg-drill-src.users` to `archive on stdout`',
  '2026-11-12T07:03:53.750+0000\twriting `vg-drill-src.refreshtokens` to `archive on stdout`',
  '2026-11-12T07:03:53.755+0000\tdone dumping `vg-drill-src.users` (2 documents)',
  '2026-11-12T07:03:53.756+0000\tdone dumping `vg-drill-src.refreshtokens` (1 document)',
];
/** The same without backticks (older database-tools). */
const DUMP_PLAIN = DUMP_100_20.map((l) => l.replace(/`/g, ''));
/** Captured from `mongorestore --nsFrom=vg-drill-src.* --nsTo=vg-drill-restore.*` (100.20.1). */
const RESTORE_100_20 = [
  '2026-11-12T07:03:53.771+0000\tpreparing collections to restore from',
  '2026-11-12T07:03:53.860+0000\tfinished restoring `vg-drill-restore.users` (2 documents, 0 failures)',
  '2026-11-12T07:03:53.921+0000\tfinished restoring `vg-drill-restore.refreshtokens` (1 document, 0 failures)',
  '2026-11-12T07:03:53.921+0000\t3 document(s) restored successfully. 0 document(s) failed to restore.',
];

const FAKE_DUMP = `
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('mongodump version: 100.20.1'); process.exit(0); }
process.stdout.write('ARCHIVE-BYTES');
process.stderr.write(fs.readFileSync(process.env.FAKE_LOG, 'utf8'));
`;
const FAKE_RESTORE = `
const fs = require('fs');
process.stdin.resume();
process.stdin.on('end', () => process.stderr.write(fs.readFileSync(process.env.FAKE_LOG, 'utf8')));
`;
const FAKE_MONGOSH = `process.stdin.resume(); process.stdin.on('end', () => console.log('absent'));`;
/** gpg: encrypt = copy stdin to -o; list-packets = a public-key encrypted AEAD packet; decrypt = good pinned sig. */
const FAKE_GPG = `
const fs = require('fs');
const a = process.argv.slice(2);
const val = (f) => a[a.indexOf(f) + 1];
if (a.includes('--list-packets')) {
  console.log(':pubkey enc packet: version 3, algo 1, keyid 0F5F83B1424697CB');
  console.log('# off=399 ctb=d4 tag=20 hlen=2 plen=65 new-ctb');
} else if (a.includes('--encrypt')) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => fs.writeFileSync(val('-o'), Buffer.concat(chunks)));
} else if (a.includes('--decrypt')) {
  fs.writeFileSync(val('--status-file'), '[GNUPG:] DECRYPTION_OKAY\\n[GNUPG:] GOODSIG X drill\\n[GNUPG:] VALIDSIG ${FPR} 2026-11-12 0 4 0 1 10 00 ${FPR}\\n');
  process.stdout.write(fs.readFileSync(a[a.length - 1]));
}
`;

describe('ops/backup scripts parse the real mongodump / mongorestore output (DEBT-620)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vg-backup-spec-'));
    for (const [name, code] of Object.entries({
      'dump.js': FAKE_DUMP,
      'restore.js': FAKE_RESTORE,
      'mongosh.js': FAKE_MONGOSH,
      'gpg.js': FAKE_GPG,
    })) {
      writeFileSync(join(dir, name), code);
    }
    writeFileSync(join(dir, 'pub.asc'), 'fake public key');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const node = (f: string) => `node ${fwd(join(dir, f))}`;
  const bash = (script: string, args: string[], env: Record<string, string>) =>
    spawnSync('bash', [fwd(script), ...args], {
      env: { ...process.env, MONGO_URI: 'mongodb://127.0.0.1:1/', GPG: node('gpg.js'), ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
  const backup = (db: string, lines: string[]) => {
    const log = join(dir, 'dump.log');
    writeFileSync(log, `${lines.join('\n')}\n`);
    const out = join(dir, 'out');
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    const r = bash(BACKUP, [db, fwd(out)], {
      MONGODUMP: node('dump.js'),
      FAKE_LOG: fwd(log),
      BACKUP_PUBKEY: fwd(join(dir, 'pub.asc')),
      BACKUP_SIGN_KEY: FPR,
    });
    return { r, out, files: readdirSync(out) };
  };
  const manifestOf = (out: string, files: string[]) =>
    JSON.parse(
      readFileSync(join(out, files.find((f) => f.endsWith('.manifest.json'))!), 'utf8'),
    ) as {
      collections: Record<string, number>;
      totalDocuments: number;
    };

  it.each([
    ['database-tools 100.20 (namespace in backticks)', DUMP_100_20],
    ['older form (no backticks)', DUMP_PLAIN],
  ])('backup counts documents per collection: %s', (_name, lines) => {
    const { r, out, files } = backup('vg-drill-src', lines);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(files.filter((f) => !f.endsWith('.partial')).length).toBe(2);
    const m = manifestOf(out, files);
    expect(m.collections).toEqual({ users: 2, refreshtokens: 1 });
    expect(m.totalDocuments).toBe(3);
  });

  it('counts only the dumped db: lines of a db sharing the prefix are ignored => no collection => exit 1', () => {
    const other = DUMP_100_20.map((l) => l.replace(/vg-drill-src\./g, 'vg-drill-srcx.'));
    const { r, files } = backup('vg-drill-src', other);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/mongodump reported no collection/);
    expect(files).toEqual([]);
  });

  it.each([
    ['matching manifest', 3, 0],
    ['manifest says one more document', 4, 1],
  ])('restore checks the real summary line: %s', (_name, total, status) => {
    const file = join(dir, 'idp-vg-drill-src-20261112T070353Z.archive.gz.gpg');
    writeFileSync(file, 'ARCHIVE-BYTES');
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    writeFileSync(
      `${file}.manifest.json`,
      `{"db":"vg-drill-src","startedAt":"x","finishedAt":"y","toolVersion":"t","collections":{"users":2,"refreshtokens":1},"totalDocuments":${total},"bytes":13,"sha256":"${sha}"}\n`,
    );
    const log = join(dir, 'restore.log');
    writeFileSync(log, `${RESTORE_100_20.join('\n')}\n`);
    const r = bash(RESTORE, [fwd(file), 'vg-drill-src', 'vg-drill-restore'], {
      MONGORESTORE: node('restore.js'),
      MONGOSH: node('mongosh.js'),
      FAKE_LOG: fwd(log),
      BACKUP_SIGNER_FPR: FPR,
    });
    expect(r.status).toBe(status);
    if (status === 0)
      expect(r.stdout).toMatch(/ok vg-drill-src -> vg-drill-restore \(3 documents, 0 failed\)/);
    else expect(r.stderr).toMatch(/restored 3 documents \(0 failed\), manifest says 4/);
  });
});
