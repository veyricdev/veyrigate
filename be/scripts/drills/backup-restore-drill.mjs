#!/usr/bin/env node
// Backup/restore drill (run 87 T1, DEBT-253, D87.2–D87.11). Reproduce with:
//   pnpm -C be build && node be/scripts/drills/backup-restore-drill.mjs [--dry-run] [--recover-cli <admin-recover.js>]
// Namespace (asserted before any write): Mongo veyrigate-mongo 127.0.0.1:27017, DBs vg-drill-src / vg-drill-restore
// (must not exist), Redis db 7 (must be empty), port 4987. Uses ops/backup/*.sh and the section-4c mongosh file
// exactly as runbook-ops section 4 does (mongodump/mongorestore/mongosh run inside the container via docker exec;
// the plaintext archive never touches a disk). Cleans up in `finally` and post-checks; evidence (counts, digests,
// HTTP codes, kids, timings, tool versions - no token/password/hash/real email) goes to runs/87-X6-drills/evidence/.
// --dry-run: checks tools + namespace, writes nothing, exits 0. The drill only cleans up what it OWNS: when the lock
// (one drill at a time) or the namespace guard refuses, it exits 1 and touches nothing (no FLUSHDB, no drop).
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  ADMIN_SCOPE, DIST, FE_ADMIN, REPO, acquireLock, assertNamespace, bash, beEnv, bearer, budget, childEnv,
  cleanupNamespace, codeFlow, dbUri, digestDb, hex, http, makeChecks, makeLog, mongoAdmin, mongosh, mongoshStdin,
  postCheck, refresh, removeDir, run, runDist, startBe, tempDir, timed, track, writeEvidence,
} from './lib.mjs';
import { DRILL_COUNTS, seedDrillData } from './seed-drill-data.mjs';

const SRC = 'vg-drill-src';
const RST = 'vg-drill-restore';
const PORT = 4987;
const REDIS_DB = 7;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'drill-admin@drill.invalid';
const ADMIN_RESOURCE = `${BASE}/admin/`;
const MONGO_IN_CONTAINER = 'mongodb://127.0.0.1:27017/?directConnection=true';
const BACKUP = join(REPO, 'ops', 'backup', 'mongo-backup.sh');
const RESTORE = join(REPO, 'ops', 'backup', 'mongo-restore.sh');
const REVOKE_JS = join(REPO, 'ops', 'backup', 'revoke-all-refresh-tokens.mongosh.js');
const RUNBOOK_DEPLOY = join(REPO, 'docs', 'agile', 'sso-idp', 'runbook-deploy.md');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const cliAt = argv.indexOf('--recover-cli');
const recoverCli = cliAt >= 0 ? argv[cliAt + 1] : join(DIST, 'database', 'admin-recover.js');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dry-run') continue;
  if (argv[i] === '--recover-cli' && argv[i + 1]) {
    i++;
    continue;
  }
  console.error('usage: backup-restore-drill.mjs [--dry-run] [--recover-cli <path to admin-recover.js>]');
  process.exit(1);
}

/** Forward slashes (Git Bash and Windows both accept them); `/c/...` form for gpg socket redirects. */
const fwd = (p) => p.replace(/\\/g, '/');
const msys = (p) => fwd(p).replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);

async function preflight() {
  const missing = [];
  for (const f of ['main.js', 'database/seed.js', 'database/seed-dev.js', 'database/mongo/sync-indexes.js']) {
    if (!existsSync(join(DIST, f))) missing.push(`be/dist/${f}`);
  }
  if (!existsSync(recoverCli)) missing.push('admin-recover.js');
  if (missing.length) throw new Error(`missing (run pnpm -C be build): ${missing.join(', ')}`);
  const docker = await run('docker', ['inspect', '-f', '{{.State.Running}}', 'veyrigate-mongo']);
  if (docker.stdout.trim() !== 'true') throw new Error('veyrigate-mongo is not running (docker start veyrigate-mongo)');
  const gpg = await run('gpg', ['--version']);
  if (gpg.code !== 0) throw new Error('gpg not found on PATH');
  return { gpg: gpg.stdout.split('\n')[0].trim() };
}

/**
 * Throwaway keys (no passphrase in the drill; production keys have one) + short agent socket: the restore
 * (encryption) key, the backup host's signing key (pinned by the restore, DEBT-617) and a rogue signing key.
 * `holder.sock` is set first so `finally` removes it even when key generation fails.
 */
async function makeKeys(work, holder) {
  const home = join(work, 'gnupg');
  const sock = await tempDir('s'); // socket names must stay short (gpg limit ~107 chars)
  holder.sock = sock;
  mkdirSync(home, { mode: 0o700 });
  // No smartcard daemon: a stray scdaemon spawned by `--sign` must not hold pipes open (tester, DEBT-621).
  writeFileSync(join(home, 'gpg-agent.conf'), 'disable-scdaemon\n');
  for (const s of ['S.gpg-agent', 'S.gpg-agent.extra', 'S.gpg-agent.browser', 'S.gpg-agent.ssh', 'S.keyboxd', 'S.dirmngr', 'S.scdaemon']) {
    writeFileSync(join(home, s), `%Assuan%\nsocket=${msys(join(sock, s))}\n`);
  }
  const env = { ...process.env, GNUPGHOME: msys(home) };
  holder.env = env;
  const gen = (uid, use) => run('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-gen-key', uid, 'rsa3072', use, '1d'], { env });
  const fpr = async (email) =>
    /^fpr:+([0-9A-F]{40}):/m.exec((await run('gpg', ['--with-colons', '--list-keys', email], { env })).stdout)?.[1];
  for (const [uid, use] of [
    ['veyrigate drill <drill-backup@drill.invalid>', 'encr'],
    ['veyrigate drill signer <drill-signer@drill.invalid>', 'sign'],
    ['rogue signer <drill-rogue@drill.invalid>', 'sign'],
  ]) {
    if ((await gen(uid, use)).code !== 0) throw new Error('gpg key generation failed');
  }
  const pub = await run('gpg', ['--armor', '--export', 'drill-backup@drill.invalid'], { env });
  const pubFile = join(work, 'backup-pub.asc');
  writeFileSync(pubFile, pub.stdout);
  const signFpr = await fpr('drill-signer@drill.invalid');
  const rogueFpr = await fpr('drill-rogue@drill.invalid');
  if (!signFpr || !rogueFpr) throw new Error('gpg fingerprints not found');
  return Object.assign(holder, { home: msys(home), pubFile: fwd(pubFile), signFpr, rogueFpr });
}

/** The mongosh blocks of runbook-deploy section 15, with <db_production> replaced. */
function section15Blocks(db) {
  const md = readFileSync(RUNBOOK_DEPLOY, 'utf8');
  const sec = md.slice(md.indexOf('## 15.'));
  const blocks = [...sec.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1].replaceAll('<db_production>', db));
  if (blocks.length < 2) throw new Error('runbook-deploy section 15 blocks not found');
  return { dry: blocks[0], apply: blocks[0] + blocks[1] };
}
const modified = (out) => [...out.matchAll(/modifiedCount:\s*(\d+)/g)].map((m) => Number(m[1]));

/** `admin-recover` with the restored app env; answers the printed code like the approver would. */
function recover(env, cwd, args) {
  return new Promise((resolveRun, reject) => {
    const child = track(spawn(process.execPath, [recoverCli, ...args], { env: childEnv(env), cwd, stdio: ['pipe', 'pipe', 'pipe'] }));
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d;
      const code = /confirmation code: (\d{4}-\d{4})/.exec(out)?.[1];
      if (code && !child.stdin.writableEnded) child.stdin.end(`${code}\n`);
    });
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    const t = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(t);
      resolveRun({ code, stdout: out, stderr: err });
    });
  });
}

async function main() {
  const { lines, log } = makeLog();
  const { results, check } = makeChecks();
  const timings = {};
  const secrets = [];
  const evidence = { drill: 'backup-restore', startedAt: new Date().toISOString(), checks: results, timings };
  const tools = await preflight();
  const conn = await mongoAdmin();
  const ns = { conn, dbs: [SRC, RST], redisDbs: [REDIS_DB] };
  let work;
  const keys = {};
  let e2eBefore = null;
  let owned = false; // set only once the lock AND every namespace guard passed (senior 1)
  let releaseLock;
  const bes = [];
  const timer = budget(10 * 60_000);
  try {
    releaseLock = acquireLock('backup-restore');
    ({ e2eBefore } = await assertNamespace({ ...ns, ports: [PORT] }));
    log(`namespace ok: ${SRC}, ${RST} absent; redis db ${REDIS_DB} empty; port ${PORT} free`);
    if (dryRun) {
      log('dry-run: tools and namespace ok, nothing written');
      return;
    }
    owned = true;
    work = await tempDir('br');
    const cwd = join(work, 'cwd');
    const keyDir = join(work, 'keys');
    const outDir = join(work, 'backup');
    const textfile = join(work, 'textfile');
    for (const d of [cwd, keyDir, outDir, textfile]) mkdirSync(d, { mode: 0o700 });
    const adminPassword = hex(16);
    const devPassword = hex(16);
    secrets.push(adminPassword, devPassword);
    const srcEnv = beEnv({ port: PORT, db: SRC, redisDb: REDIS_DB, keyDir, extra: { METRICS_TOKEN: hex() } });
    secrets.push(srcEnv.CSRF_SECRET, srcEnv.METRICS_TOKEN);

    // 1. Seed the source.
    const seedEnv = { ...srcEnv, NODE_ENV: 'test', ADMIN_SEED_EMAIL: ADMIN_EMAIL, ADMIN_SEED_PASSWORD: adminPassword };
    const seed = await runDist('database/seed.js', [], seedEnv, cwd);
    check('db:seed exit 0', seed.code === 0);
    const feSecret = /fe-admin client_secret \(shown once\): (\S+)/.exec(seed.stdout)?.[1];
    check('fe-admin secret issued', !!feSecret);
    secrets.push(feSecret);
    const client = { clientId: FE_ADMIN.clientId, secret: feSecret };
    const dev = await runDist('database/seed-dev.js', [], { ...seedEnv, DEV_SEED_EMAIL: 'drill-dev@drill.invalid', DEV_SEED_PASSWORD: devPassword }, cwd);
    check('db:seed-dev exit 0', dev.code === 0);
    evidence.seeded = await seedDrillData(conn.getClient().db(SRC), { adminResource: ADMIN_RESOURCE });
    log(`seeded ${SRC}: ${JSON.stringify(evidence.seeded)}`);

    // 2. App on the source: a real admin code flow, keep RT_pre in memory.
    const flow = { email: ADMIN_EMAIL, password: adminPassword, ...client, redirectUri: FE_ADMIN.redirectUri, scope: ADMIN_SCOPE, resource: ADMIN_RESOURCE };
    let be = await startBe('be-src', PORT, srcEnv, cwd);
    bes.push(be);
    const pre = (await codeFlow(BASE, flow)).tokens;
    secrets.push(pre.access_token, pre.refresh_token, pre.id_token);
    check('source: GET /admin/keys 200', (await bearer(BASE, '/admin/keys', pre.access_token)).status === 200);
    await be.stop();
    log('source app stopped (RT_pre kept in memory)');

    // 3. Encrypted backup (ops/backup/mongo-backup.sh, gpg public key only).
    await makeKeys(work, keys);
    const backupEnv = { GNUPGHOME: keys.home, BACKUP_PUBKEY: keys.pubFile, BACKUP_SIGN_KEY: keys.signFpr, MONGO_URI: MONGO_IN_CONTAINER,
      MONGODUMP: 'docker exec veyrigate-mongo mongodump', BACKUP_TEXTFILE_DIR: fwd(textfile) };
    const bk = await timed(timings, 'dumpEncryptMs', () => bash(BACKUP, [SRC, fwd(outDir)], backupEnv));
    check('mongo-backup.sh exit 0', bk.code === 0, bk.code);
    const archive = readdirSync(outDir).find((f) => /^idp-vg-drill-src-\d{8}T\d{6}Z\.archive\.gz\.gpg$/.test(f));
    check('backup file has the standard name', !!archive);
    const file = join(outDir, archive);
    const manifest = JSON.parse(readFileSync(`${file}.manifest.json`, 'utf8'));
    check('no .partial left', !readdirSync(outDir).some((f) => f.endsWith('.partial')));
    const metric = readFileSync(join(textfile, `veyrigate_backup_${SRC}.prom`), 'utf8');
    check('metric written', /veyrigate_backup_last_success_timestamp_seconds\{db="vg-drill-src"\} \d+/.test(metric));
    evidence.backup = { file: archive, manifest: { ...manifest } };
    const srcDigest = await timed(timings, 'digestSrcMs', () => digestDb(conn, SRC));
    check('manifest totalDocuments = source document count', manifest.totalDocuments === Object.values(srcDigest).reduce((n, c) => n + c.count, 0));

    // 4. Negative cases of the scripts (T1 AC script 1-5), before the real restore.
    const neg = {};
    const restoreEnv = { GNUPGHOME: keys.home, BACKUP_SIGNER_FPR: keys.signFpr, MONGO_URI: MONGO_IN_CONTAINER,
      MONGORESTORE: 'docker exec -i veyrigate-mongo mongorestore', MONGOSH: 'docker exec -i veyrigate-mongo mongosh' };
    const noConnEnv = { ...restoreEnv, MONGORESTORE: 'false', MONGOSH: 'false' };
    {
      const uri = `mongodb://drill:${hex(8)}@127.0.0.1:27017/`;
      const r = await bash(BACKUP, [SRC, fwd(outDir)], { ...backupEnv, MONGO_URI: uri });
      neg.credentialUriRefused = r.code !== 0 && !(r.stdout + r.stderr).includes(uri);
      check('AC3 MONGO_URI with credentials refused, not echoed', neg.credentialUriRefused);
    }
    {
      const before = readdirSync(outDir).sort().join(',');
      const metricBefore = readFileSync(join(textfile, `veyrigate_backup_${SRC}.prom`), 'utf8');
      const mtime = statSync(join(textfile, `veyrigate_backup_${SRC}.prom`)).mtimeMs;
      const r = await bash(BACKUP, [SRC, fwd(outDir)], { ...backupEnv, MONGODUMP: 'false' });
      neg.dumpFailure = r.code !== 0 && readdirSync(outDir).sort().join(',') === before &&
        readFileSync(join(textfile, `veyrigate_backup_${SRC}.prom`), 'utf8') === metricBefore &&
        statSync(join(textfile, `veyrigate_backup_${SRC}.prom`)).mtimeMs === mtime;
      check('AC4 failing mongodump: exit != 0, no new file, no .partial, metric unchanged', neg.dumpFailure);
    }
    {
      await conn.getClient().db(RST).collection('drill_marker').insertOne({ marker: 1 });
      const r = await bash(RESTORE, [fwd(file), SRC, RST], restoreEnv);
      const after = await conn.getClient().db(RST).collection('drill_marker').countDocuments();
      const colls = (await conn.getClient().db(RST).listCollections().toArray()).map((c) => c.name);
      neg.existingDstRefused = r.code !== 0 && /already exists/.test(r.stderr) && after === 1 && colls.length === 1;
      await conn.getClient().db(RST).dropDatabase();
      check('AC1 restore into an existing db refused, db unchanged', neg.existingDstRefused);
    }
    {
      const same = await bash(RESTORE, [fwd(file), SRC, SRC], noConnEnv);
      const drop = await bash(RESTORE, [fwd(file), SRC, RST, '--drop'], noConnEnv);
      const tdir = join(work, 'tampered');
      mkdirSync(tdir);
      const tfile = join(tdir, archive);
      const bytes = readFileSync(file);
      bytes[Math.floor(bytes.length / 2)] ^= 0x01;
      writeFileSync(tfile, bytes);
      copyFileSync(`${file}.manifest.json`, `${tfile}.manifest.json`);
      const tampered = await bash(RESTORE, [fwd(tfile), SRC, RST], noConnEnv);
      neg.sameDb = same.code !== 0 && /must differ/.test(same.stderr);
      neg.dropOption = drop.code !== 0 && /options are not accepted/.test(drop.stderr);
      neg.tamperedSha = tampered.code !== 0 && /sha256 does not match/.test(tampered.stderr);
      check('AC2 dst == src refused before connecting', neg.sameDb);
      check('AC2 --drop refused before connecting', neg.dropOption);
      check('AC2 one flipped byte => sha256 refused before connecting', neg.tamperedSha);
    }
    {
      // DEBT-617: encrypted to the right key but signed by an unpinned key => refused before mongorestore.
      const rdir = join(work, 'rogue');
      mkdirSync(rdir);
      const rb = await bash(BACKUP, [SRC, fwd(rdir)], { ...backupEnv, BACKUP_SIGN_KEY: keys.rogueFpr });
      const rogue = readdirSync(rdir).find((f) => f.endsWith('.archive.gz.gpg'));
      const r = rogue ? await bash(RESTORE, [fwd(join(rdir, rogue)), SRC, RST], noConnEnv) : { code: 0, stderr: '' };
      const dbsNow = (await conn.db.admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
      neg.rogueSigner = rb.code === 0 && r.code !== 0 && /not signed by the pinned backup key/.test(r.stderr) && !dbsNow.includes(RST);
      check('DEBT-617 archive signed by an unpinned key refused before mongorestore', neg.rogueSigner);
    }
    {
      const mdir = join(work, 'badcount');
      mkdirSync(mdir);
      const mfile = join(mdir, archive);
      copyFileSync(file, mfile);
      writeFileSync(`${mfile}.manifest.json`, JSON.stringify({ ...manifest, totalDocuments: manifest.totalDocuments + 1 }) + '\n');
      const r = await bash(RESTORE, [fwd(mfile), SRC, RST], restoreEnv);
      neg.countMismatch = r.code === 1 && /manifest says/.test(r.stderr);
      await conn.getClient().db(RST).dropDatabase();
      check('AC5 restored count != manifest => exit 1', neg.countMismatch);
    }
    evidence.negativeCases = neg;
    log(`negative cases: ${JSON.stringify(neg)}`);

    // 5. Real restore into a NEW db, then the full digest comparison.
    const rs = await timed(timings, 'decryptRestoreMs', () => bash(RESTORE, [fwd(file), SRC, RST], restoreEnv));
    check('mongo-restore.sh exit 0', rs.code === 0, rs.stderr.split('\n').filter(Boolean).slice(-1)[0]);
    const rstDigest = await timed(timings, 'digestRestoreMs', () => digestDb(conn, RST));
    const diff = Object.keys({ ...srcDigest, ...rstDigest }).filter((c) => JSON.stringify(srcDigest[c]) !== JSON.stringify(rstDigest[c]));
    evidence.digest = Object.fromEntries(Object.entries(srcDigest).map(([c, d]) => [c, { count: d.count, sha256: d.sha256, indexes: d.indexes.map((i) => i.name) }]));
    check('every collection: same count, index specs and canonical EJSON sha256', diff.length === 0, diff);

    // 6. Section 4c through the SAME file as the runbook.
    const revokeOut = await timed(timings, 'revokeAllRtMs', () =>
      mongoshStdin(`db = connect('${MONGO_IN_CONTAINER}');\nconst TARGET='${RST}';\n${readFileSync(REVOKE_JS, 'utf8')}`));
    check('section 4c: active RT 0', revokeOut.code === 0 && /active RT: 0\b/.test(revokeOut.stdout));
    evidence.revokeAll = { output: revokeOut.stdout.trim().split('\n').filter((l) => /^(DB|active RT|total RT):/.test(l)) };

    // 7. db:sync-indexes on the restored db.
    const rstEnv = { ...srcEnv, MONGO_URI: dbUri(RST) };
    const sync = await timed(timings, 'syncIndexesMs', () => runDist('database/mongo/sync-indexes.js', [], rstEnv, cwd));
    const syncLines = sync.stdout.split('\n').filter((l) => /: synced/.test(l));
    check('db:sync-indexes exit 0, every model synced, nothing dropped', sync.code === 0 && syncLines.length > 0 && !/dropped/.test(sync.stdout));
    evidence.syncIndexes = syncLines;

    // 8. App on the restored db with the SAME key dir (keys are not in Mongo).
    be = await timed(timings, 'bootMs', () => startBe('be-restore', PORT, rstEnv, cwd));
    bes.push(be);
    timings.technicalTotalMs = timings.decryptRestoreMs + timings.revokeAllRtMs + timings.syncIndexesMs + timings.bootMs;
    check('technical restore <= 10 min (D87.3 drill bound)', timings.technicalTotalMs <= 10 * 60_000, timings.technicalTotalMs);
    const disc = await http(`${BASE}/.well-known/openid-configuration`);
    const jwks = await (await http(`${BASE}/jwks.json`)).json();
    check('discovery 200', disc.status === 200);
    check('jwks has >= 1 key', jwks.keys?.length >= 1);
    evidence.restoredApp = { health: 200, ready: 200, discovery: disc.status, jwksKids: jwks.keys.map((k) => k.kid) };
    const preRefresh = await refresh(BASE, client, pre.refresh_token);
    const preBody = await preRefresh.json();
    check('RT_pre (rotated/revoked after restore by 4c) => 400 invalid_grant', preRefresh.status === 400 && preBody.error === 'invalid_grant');
    const post = (await codeFlow(BASE, flow)).tokens;
    secrets.push(post.access_token, post.refresh_token, post.id_token);
    check('restored: admin login + GET /admin/keys 200', (await bearer(BASE, '/admin/keys', post.access_token)).status === 200);
    const newRefresh = await refresh(BASE, client, post.refresh_token);
    const nr = await newRefresh.json();
    secrets.push(nr.access_token, nr.refresh_token, nr.id_token);
    check('a new RT refreshes => 200', newRefresh.status === 200);
    evidence.restoredApp.rtPre = { status: preRefresh.status, error: preBody.error };
    evidence.restoredApp.rtNew = newRefresh.status;

    // 9. T4 AC5: runbook-deploy section 15 on the restored db (dry-run, apply, re-apply, count).
    const s15 = section15Blocks(RST);
    const dry1 = await mongosh(MONGO_IN_CONTAINER, s15.dry);
    const counts1 = /legacy fields: (\d+) expired temporary locks: (\d+)/.exec(dry1.stdout);
    const apply1 = await mongosh(MONGO_IN_CONTAINER, s15.apply);
    const apply2 = await mongosh(MONGO_IN_CONTAINER, s15.apply);
    const dry2 = await mongosh(MONGO_IN_CONTAINER, s15.dry);
    const counts2 = /legacy fields: (\d+) expired temporary locks: (\d+)/.exec(dry2.stdout);
    evidence.section15 = {
      dryRun: counts1 ? { legacy: Number(counts1[1]), expiredLocks: Number(counts1[2]) } : null,
      apply: modified(apply1.stdout),
      reapply: modified(apply2.stdout),
      after: counts2 ? { legacy: Number(counts2[1]), expiredLocks: Number(counts2[2]) } : null,
    };
    check('section 15 dry-run finds the seeded legacy users', counts1 && Number(counts1[1]) === DRILL_COUNTS.legacy, evidence.section15.dryRun);
    check('section 15 apply modifies exactly them', evidence.section15.apply[0] === DRILL_COUNTS.legacy);
    check('section 15 is idempotent (0, 0)', JSON.stringify(evidence.section15.reapply) === '[0,0]');
    check('section 15 leaves 0 0', counts2 && counts2[1] === '0' && counts2[2] === '0');

    // 10. T2 on the restored db: admin locked, admin-recover --unlock from the deploy layout, login again.
    await mongosh(MONGO_IN_CONTAINER, `db.getSiblingDB('${RST}').users.updateOne({ email: '${ADMIN_EMAIL}' }, { $set: { lockedUntil: ISODate('9999-12-31T23:59:59.999Z'), adminLockLevel: 'super_admin' } })`);
    let blocked = false;
    try {
      await codeFlow(BASE, flow);
    } catch {
      blocked = true;
    }
    check('locked admin cannot sign in', blocked);
    const cliArgs = ['--email', ADMIN_EMAIL, '--requested-by', 'drill-ops-a', '--approved-by', 'drill-ops-b', '--ticket', 'DRILL-87'];
    const dryCli = await recover(rstEnv, cwd, [...cliArgs, '--dry-run']);
    check('admin-recover --dry-run exit 0, no connection line', dryCli.code === 0 && /dry-run: no connection made/.test(dryCli.stdout));
    const cli = await timed(timings, 'adminRecoverMs', () => recover(rstEnv, cwd, [...cliArgs, '--unlock']));
    check('admin-recover --unlock exit 0', cli.code === 0, cli.stderr.trim());
    check('admin-recover output has no email', !(cli.stdout + cli.stderr).includes(ADMIN_EMAIL));
    const after = (await codeFlow(BASE, flow)).tokens;
    secrets.push(after.access_token, after.refresh_token, after.id_token);
    const audit = await bearer(BASE, '/admin/audit?action=ADMIN_RECOVERED', after.access_token);
    const items = (await audit.json()).items ?? [];
    check('GET /admin/audit?action=ADMIN_RECOVERED shows the success event', audit.status === 200 && items.some((e) => e.result === 'success'));
    evidence.adminRecover = {
      cli: recoverCli.startsWith(DIST) ? 'be/dist' : 'external (--recover-cli, e.g. a pnpm deploy --prod layout)',
      planLines: cli.stdout.split('\n').filter((l) => /^(target|locked|usable super_admins|recovered):/.test(l)).map((l) => l.replace(/user [0-9a-f]{24}/, 'user <id>')),
      auditStatus: audit.status,
      auditItems: items.length,
    };
    await be.stop();
    evidence.tools = { ...tools, mongodump: manifest.toolVersion, node: process.version,
      mongod: (await conn.db.admin().command({ buildInfo: 1 })).version,
      head: (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO })).stdout.trim() };
    evidence.limits = 'BE runs NODE_ENV=development (production needs https Vault + Secure cookies, covered by docker-smoke.sh); gpg key without passphrase (production key has one, held by two people).';
  } catch (err) {
    evidence.error = timer.expired ? `time budget exceeded (${err.message})` : err.message;
  } finally {
    timer.stop();
    for (const b of bes) await b.stop().catch(() => undefined);
    if (owned) {
      evidence.cleanupErrors = await cleanupNamespace(ns);
      if (keys.env) await run('gpgconf', ['--kill', 'gpg-agent'], { env: keys.env }).catch(() => undefined);
      await removeDir(keys.sock);
      await removeDir(work);
      evidence.postCheck = await postCheck({ ...ns, e2eBefore }).catch((e) => ({ error: e.message, drillDbsLeft: ['unknown'], redisDbSizes: {} }));
    }
    releaseLock?.();
    // DEBT-621: never let an open Mongo socket keep the process alive.
    await conn.close().catch(() => undefined);
  }
  evidence.finishedAt = new Date().toISOString();
  if (!owned) {
    // Refused by the lock / a guard, or a dry run: nothing was written, nothing is cleaned, no evidence.
    if (evidence.error) {
      console.error(`backup-restore drill REFUSED (nothing touched): ${evidence.error}`);
      process.exitCode = 1;
    }
    return;
  }
  {
    evidence.ok = !evidence.error && results.every((r) => r.ok) && evidence.postCheck.drillDbsLeft.length === 0 &&
      Object.values(evidence.postCheck.redisDbSizes).every((n) => n === 0) && evidence.postCheck.e2eUnchanged;
    const path = writeEvidence('backup-restore', evidence, lines, secrets);
    log(`evidence: ${path}`);
    if (!evidence.ok) {
      console.error(`backup-restore drill FAILED${evidence.error ? `: ${evidence.error}` : ''}`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(`backup-restore drill FAILED: ${err.message}`);
  process.exitCode = 1;
});
