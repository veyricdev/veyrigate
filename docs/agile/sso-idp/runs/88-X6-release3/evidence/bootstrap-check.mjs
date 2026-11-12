// Run 88 T4: manual runbook-deploy §16 pass on DB vg-bootstrap-check (27117), from a
// `pnpm deploy --prod` layout (no local node base image => no docker build). The secret never
// leaves this process: every captured stdout line `OIDC_CLIENT_SECRET=…` is checked in memory
// (format + argon2 verify against the stored hash) and only a mask is printed / recorded.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

const HERE = import.meta.dirname;
const DEPLOY = join(HERE, 'deploy');
const ENV_FILE = join(HERE, 'app.env');
const DB = 'vg-bootstrap-check';
const OUT = process.argv[2];
const require = createRequire(join(DEPLOY, 'package.json'));
const { MongoClient } = require('mongoose').mongo;
const { verifyPassword } = require(join(DEPLOY, 'dist/common/crypto/crypto.util.js'));

const URIS = {
  BOOTSTRAP_FE_ADMIN_REDIRECT_URIS: 'https://admin.example.com/auth/callback',
  BOOTSTRAP_FE_ADMIN_POST_LOGOUT_REDIRECT_URIS: 'https://admin.example.com/',
};
const SECRET_RE = /^OIDC_CLIENT_SECRET=([A-Za-z0-9_-]{43})$/;
const steps = [];
const secrets = []; // in memory only
let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures++;
  steps.at(-1).checks.push({ name, pass: !!ok, ...(detail ? { detail } : {}) });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

function run(title, script, argv, envExtra = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [`--env-file=${ENV_FILE}`, script, ...argv], {
      cwd: DEPLOY,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? '', ...envExtra },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.stdin.end();
    child.on('close', (status) => {
      const ms = Date.now() - t0;
      const found = [];
      const mask = (text) =>
        text
          .split(/\r?\n/)
          .map((l) => {
            const m = SECRET_RE.exec(l);
            if (m) {
              found.push(m[1]);
              return `OIDC_CLIENT_SECRET=<masked: 43 chars, base64url>`;
            }
            return l.startsWith('OIDC_CLIENT_SECRET') ? 'OIDC_CLIENT_SECRET<MALFORMED, masked>' : l;
          })
          .join('\n');
      const out = mask(stdout);
      const err = mask(stderr);
      const step = { title, cmd: `node ${script} ${argv.join(' ')}`, exit: status, ms, stdout: out.trim(), stderr: err.trim(), checks: [] };
      steps.push(step);
      console.log(`\n## ${title}\n$ ${step.cmd}\nexit=${status} ${ms} ms\n${out.trim()}${err.trim() ? `\n[stderr] ${err.trim()}` : ''}`);
      const raw = stdout + stderr;
      resolve({ status, ms, out, err, found, raw });
    });
  });
}

const BOOT = 'dist/database/bootstrap.js';
const SYNC = 'dist/database/mongo/sync-indexes.js';
const client = new MongoClient('mongodb://127.0.0.1:27117/?directConnection=true');
await client.connect();
let accepted = 0;
const counter = createServer((sock) => { accepted++; sock.destroy(); });
await new Promise((r) => counter.listen(0, '127.0.0.1', r));
const COUNTER_URI = `mongodb://127.0.0.1:${counter.address().port}/vg-bootstrap-check?directConnection=true`;
const db = client.db(DB);

async function snapshot() {
  const snap = {};
  for (const c of await db.listCollections().toArray()) {
    const docs = await db.collection(c.name).find({}).sort({ _id: 1 }).toArray();
    snap[c.name] = JSON.stringify(docs);
  }
  return snap;
}
const counts = async () => {
  const r = {};
  for (const c of await db.listCollections().toArray()) r[c.name] = await db.collection(c.name).countDocuments();
  return r;
};
const sameSnap = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bootstrapAudits = () => db.collection('auditlogs').find({ action: 'ADMIN_BOOTSTRAPPED' }).sort({ _id: 1 }).toArray();
const activeCreds = () => db.collection('clientcredentials').find({ clientId: 'fe-admin', revokedAt: null }).toArray();
async function secretVerifies(secret) {
  for (const c of await activeCreds()) if (await verifyPassword(c.secretHash, secret)) return true;
  return false;
}
function leakFree(r, label) {
  const bad = ['$argon2', '@example.com', 'mongodb://'].filter((s) => r.raw.includes(s));
  // the secret may appear only in its own single stdout line
  const secretElsewhere = r.found.some((s) => r.raw.split(s).length - 1 !== 1);
  check(`${label}: no argon2 hash / email / Mongo URI in output, secret only on its line`, bad.length === 0 && !secretElsewhere, bad.join(','));
}

// --- start: the DB must not exist (it is ours) ---
const existing = (await client.db().admin().listDatabases()).databases.map((d) => d.name);
steps.push({ title: 'precondition', checks: [] });
check(`${DB} absent at start`, !existing.includes(DB));
check('vg-int-* count (info)', true, String(existing.filter((n) => n.startsWith('vg-int-')).length));

// --- 1. sync-indexes dry-run then real ---
let r = await run('1a sync-indexes --dry-run', SYNC, ['--dry-run']);
check('exit 0', r.status === 0);
check('target printed', r.out.includes(`target: 127.0.0.1:27117/${DB}`));
r = await run('1b sync-indexes', SYNC, []);
check('exit 0', r.status === 0);

// --- 2. dry-run ---
r = await run('2 bootstrap --dry-run', BOOT, ['--operator', 'ops.t88', '--dry-run'], URIS);
check('exit 0', r.status === 0);
check('target + both URI lists + dry-run line', r.out.includes(`127.0.0.1:27117/${DB}`) && r.out.includes(URIS.BOOTSTRAP_FE_ADMIN_REDIRECT_URIS) && r.out.includes('dry-run: no connection made'));
check('duration (info, machine under E2E load)', true, `${r.ms} ms`);
check('DB still has no clients', (await db.collection('clients').countDocuments()) === 0);
leakFree(r, 'dry-run');
accepted = 0;
r = await run('2b bootstrap --dry-run, MONGO_URI = counting listener', BOOT, ['--operator', 'ops.t88', '--dry-run'], { ...URIS, MONGO_URI: COUNTER_URI });
check('exit 0', r.status === 0);
check('0 TCP connections to MONGO_URI', accepted === 0, `accepted=${accepted}`);

// --- 3. real run ---
const usersBefore = await snapshot().then((s) => [s.users, s.usertenants]);
r = await run('3 bootstrap (real)', BOOT, ['--operator', 'ops.t88'], URIS);
check('exit 0', r.status === 0);
check('exactly one OIDC_CLIENT_SECRET line, format ^[A-Za-z0-9_-]{43}$', r.found.length === 1);
if (r.found[0]) secrets.push(r.found[0]);
check('"shown once" sentence', /shown once/i.test(r.out));
check('secret verifies against the stored active hash (argon2)', r.found[0] ? await secretVerifies(r.found[0]) : false);
check('1 active credential', (await activeCreds()).length === 1);
const res = await db.collection('resources').findOne({ identifier: 'https://idp.example.com/admin/' });
check('resource admin identifier = ISSUER/admin/', !!res);
const fe = await db.collection('clients').findOne({ clientId: 'fe-admin' });
check('fe-admin confidential, client_secret_basic, URIs from env, CORS empty',
  fe && fe.tokenEndpointAuthMethod === 'client_secret_basic' &&
  JSON.stringify(fe.redirectUris) === JSON.stringify([URIS.BOOTSTRAP_FE_ADMIN_REDIRECT_URIS]) &&
  JSON.stringify(fe.postLogoutRedirectUris) === JSON.stringify([URIS.BOOTSTRAP_FE_ADMIN_POST_LOGOUT_REDIRECT_URIS]) &&
  (fe.allowedCorsOrigins ?? []).length === 0,
  fe ? `auth=${fe.tokenEndpointAuthMethod} grants=${(fe.grantTypes ?? []).join(' ')}` : 'missing');
check('1 tenant created', (await db.collection('tenants').countDocuments()) === 1, JSON.stringify(await db.collection('tenants').findOne({}, { projection: { _id: 0, tenantId: 1, slug: 1, name: 1 } })));
let audits = await bootstrapAudits();
check('1 ADMIN_BOOTSTRAPPED audit, actorType system, actorId operator, credentialIssued true',
  audits.length === 1 && audits[0].actorType === 'system' && audits[0].actorId === 'ops.t88' && audits[0].result === 'success' && JSON.stringify(audits[0].metadata).includes('"credentialIssued":true'),
  audits[0] ? JSON.stringify({ result: audits[0].result, targetId: audits[0].targetId, metadata: audits[0].metadata }) : 'none');
check('audit has no secret / hash', !secrets.some((s) => JSON.stringify(audits).includes(s)) && !JSON.stringify(audits).includes('$argon2'));
check('alert JSON line on stdout', /\{"alert":true,"action":"ADMIN_BOOTSTRAPPED","eventId":"[^"]+"\}/.test(r.out));
check('usable super_admins: 0 + admin-recover hint', r.out.includes('usable super_admins: 0') && r.out.includes('admin-recover'));
check('users/usertenants unchanged', sameSnap(usersBefore, await snapshot().then((s) => [s.users, s.usertenants])));
leakFree(r, 'real run');

// --- 4. rerun ---
let before = await snapshot();
r = await run('4 bootstrap rerun', BOOT, ['--operator', 'ops.t88'], URIS);
check('exit 0', r.status === 0);
check('no secret line, "unchanged"', r.found.length === 0 && !r.out.includes('OIDC_CLIENT_SECRET') && r.out.includes('fe-admin secret: unchanged (active credential exists)'));
check('credential count unchanged', (await db.collection('clientcredentials').countDocuments()) === 1);
audits = await bootstrapAudits();
check('2nd audit credentialIssued false', audits.length === 2 && JSON.stringify(audits[1].metadata).includes('"credentialIssued":false'));
check('first secret still verifies', await secretVerifies(secrets[0]));
leakFree(r, 'rerun');

// --- 5. refusals before any connection ---
for (const [title, argv, env, expectNoWrite] of [
  ['5a unknown flag', ['--operator', 'ops.t88', '--force-SECRETVALUE'], URIS],
  ['5b bad operator', ['--operator', 'Bad Operator!'], URIS],
  ['5c missing --operator', [], URIS],
  ['5d --update-uris without --ticket', ['--operator', 'ops.t88', '--update-uris'], URIS],
  ['5e --rotate-secret without --ticket', ['--operator', 'ops.t88', '--rotate-secret'], URIS],
  ['5f production http://localhost URI', ['--operator', 'ops.t88'], { ...URIS, BOOTSTRAP_FE_ADMIN_REDIRECT_URIS: 'http://localhost:3000/auth/callback' }],
  ['5g wildcard URI', ['--operator', 'ops.t88'], { ...URIS, BOOTSTRAP_FE_ADMIN_REDIRECT_URIS: 'https://*.example.com/cb' }],
  ['5h fragment URI', ['--operator', 'ops.t88'], { ...URIS, BOOTSTRAP_FE_ADMIN_REDIRECT_URIS: 'https://admin.example.com/cb#frag' }],
  ['5i missing BOOTSTRAP env', ['--operator', 'ops.t88'], {}],
]) {
  before = await snapshot();
  accepted = 0;
  r = await run(title, BOOT, argv, { ...env, MONGO_URI: COUNTER_URI });
  check('exit 1', r.status === 1);
  check('no echo of the offending value', !/SECRETVALUE|Bad Operator|localhost:3000|\*\.example|#frag/.test(r.raw));
  check('0 TCP connections to MONGO_URI (refused before connecting)', accepted === 0, `accepted=${accepted}, ${r.ms} ms`);
  check('DB unchanged', sameSnap(before, await snapshot()));
}

// --- 6. drift => exit 2, then --update-uris --ticket ---
const DRIFT = { BOOTSTRAP_FE_ADMIN_REDIRECT_URIS: 'https://console.example.com/auth/callback', BOOTSTRAP_FE_ADMIN_POST_LOGOUT_REDIRECT_URIS: 'https://console.example.com/' };
before = await snapshot();
r = await run('6a drift (env URIs differ)', BOOT, ['--operator', 'ops.t88'], DRIFT);
check('exit 2', r.status === 2);
check('both lists printed', r.out.includes('stored redirectUris: https://admin.example.com/auth/callback') && r.out.includes('env    redirectUris: https://console.example.com/auth/callback'));
check('DB unchanged', sameSnap(before, await snapshot()));
r = await run('6b --update-uris --ticket', BOOT, ['--operator', 'ops.t88', '--update-uris', '--ticket', 'CHG-88-1'], DRIFT);
check('exit 0', r.status === 0);
const fe2 = await db.collection('clients').findOne({ clientId: 'fe-admin' });
check('both lists replaced', JSON.stringify(fe2.redirectUris) === JSON.stringify([DRIFT.BOOTSTRAP_FE_ADMIN_REDIRECT_URIS]) && JSON.stringify(fe2.postLogoutRedirectUris) === JSON.stringify([DRIFT.BOOTSTRAP_FE_ADMIN_POST_LOGOUT_REDIRECT_URIS]));
check('REDIRECT_URI_CHANGED audit', (await db.collection('auditlogs').countDocuments({ action: 'REDIRECT_URI_CHANGED' })) === 1);
audits = await bootstrapAudits();
check('ADMIN_BOOTSTRAPPED urisUpdated true + ticket', JSON.stringify(audits.at(-1).metadata).includes('"urisUpdated":true') && JSON.stringify(audits.at(-1).metadata).includes('CHG-88-1'));
check('no secret line', r.found.length === 0);
leakFree(r, 'update-uris');

// --- 7. --rotate-secret --ticket ---
r = await run('7 --rotate-secret --ticket', BOOT, ['--operator', 'ops.t88', '--rotate-secret', '--ticket', 'CHG-88-2'], DRIFT);
check('exit 0', r.status === 0);
check('exactly one new secret line', r.found.length === 1 && r.found[0] !== secrets[0]);
if (r.found[0]) secrets.push(r.found[0]);
check('old secret no longer verifies (revoked, no grace)', !(await secretVerifies(secrets[0])));
check('new secret verifies', r.found[0] ? await secretVerifies(r.found[0]) : false);
check('1 active / 2 total credentials', (await activeCreds()).length === 1 && (await db.collection('clientcredentials').countDocuments()) === 2);
audits = await bootstrapAudits();
check('audit credentialRotated true', JSON.stringify(audits.at(-1).metadata).includes('"credentialRotated":true'));
leakFree(r, 'rotate');

// --- 8. refusals after connection (DB state) ---
// 8a resource admin re-pointed
await db.collection('resources').updateOne({ identifier: 'https://idp.example.com/admin/' }, { $set: { identifier: 'https://evil.example.com/admin/' } });
before = await snapshot();
r = await run('8a resource admin re-pointed', BOOT, ['--operator', 'ops.t88'], DRIFT);
check('exit 1', r.status === 1);
check('DB unchanged', sameSnap(before, await snapshot()));
await db.collection('resources').updateOne({ identifier: 'https://evil.example.com/admin/' }, { $set: { identifier: 'https://idp.example.com/admin/' } });
// 8b fe-admin made public
const feAuth = (await db.collection('clients').findOne({ clientId: 'fe-admin' })).tokenEndpointAuthMethod;
await db.collection('clients').updateOne({ clientId: 'fe-admin' }, { $set: { tokenEndpointAuthMethod: 'none' } });
before = await snapshot();
r = await run('8b fe-admin public (none)', BOOT, ['--operator', 'ops.t88'], DRIFT);
check('exit 1', r.status === 1);
check('DB unchanged', sameSnap(before, await snapshot()));
await db.collection('clients').updateOne({ clientId: 'fe-admin' }, { $set: { tokenEndpointAuthMethod: feAuth } });
// 8c Mongo unreachable
r = await run('8c Mongo unreachable', BOOT, ['--operator', 'ops.t88'], { ...DRIFT, MONGO_URI: 'mongodb://t88user:t88-pass-not-real@127.0.0.1:1/vg-bootstrap-check' });
check('exit 1', r.status === 1);
check('password of MONGO_URI not echoed', !r.raw.includes('t88-pass-not-real'));

// --- 9. parallel on an empty DB (x5) ---
let parallelOk = 0;
for (let i = 1; i <= 5; i++) {
  await db.dropDatabase();
  const s = await run(`9.${i} sync-indexes (fresh DB)`, SYNC, []);
  check('exit 0', s.status === 0);
  const [p, q] = await Promise.all([
    run(`9.${i} bootstrap A (parallel)`, BOOT, ['--operator', 'ops.t88a'], URIS),
    run(`9.${i} bootstrap B (parallel)`, BOOT, ['--operator', 'ops.t88b'], URIS),
  ]);
  const lines = p.found.length + q.found.length;
  const creds = await db.collection('clientcredentials').countDocuments({ clientId: 'fe-admin' });
  const clients = await db.collection('clients').countDocuments({ clientId: 'fe-admin' });
  const resources = await db.collection('resources').countDocuments();
  const ok = p.status === 0 && q.status === 0 && lines === 1 && creds === 1 && clients === 1 && resources === 1;
  check(`parallel ${i}: both exit 0, exactly 1 secret line total, 1 credential/client/resource`, ok, `exit ${p.status}/${q.status} lines=${lines} creds=${creds} clients=${clients} resources=${resources}`);
  if (ok) parallelOk++;
  const sec = p.found[0] ?? q.found[0];
  if (sec) check(`parallel ${i}: printed secret verifies`, await secretVerifies(sec));
}

// --- 10. missing unique index => refuse ---
await db.dropDatabase();
await db.collection('clients').insertOne({ _probe: true });
await db.collection('clients').deleteMany({});
before = await snapshot();
r = await run('10 no indexes (sync-indexes not run)', BOOT, ['--operator', 'ops.t88'], URIS);
check('exit 1', r.status === 1);
check('"db:sync-indexes" hint', r.raw.includes('sync-indexes'));
check('DB unchanged', sameSnap(before, await snapshot()));

// --- cleanup: drop our DB ---
await db.dropDatabase();
const after = (await client.db().admin().listDatabases()).databases.map((d) => d.name);
steps.push({ title: 'cleanup', checks: [] });
check(`${DB} dropped`, !after.includes(DB));
check('vg-int-* count after (info)', true, String(after.filter((n) => n.startsWith('vg-int-')).length));
await client.close();
counter.close();

// Final guard: nothing written below may contain a secret.
const json = JSON.stringify({ generatedAt: new Date().toISOString(), db: DB, failures, steps }, null, 2);
if (secrets.some((s) => json.includes(s)) || json.includes('$argon2$')) {
  console.error('evidence would contain a secret: not written');
  process.exit(3);
}
if (OUT) writeFileSync(OUT, json);
console.log(`\nfailures: ${failures}; checks: ${steps.reduce((n, s) => n + s.checks.length, 0)}; parallel ok ${parallelOk}/5`);
process.exit(failures ? 1 : 0);
