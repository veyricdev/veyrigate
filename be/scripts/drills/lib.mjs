// Shared helpers of the run-87 drills (D87.11). Node ESM; dependencies come from be/node_modules (this file
// lives under be/), the app from be/dist (run `pnpm -C be build` first). Never writes a token, password,
// hash, real email or credentialed URI to the evidence; secrets live in memory only.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const mongoose = require('mongoose');
export const IORedis = require('ioredis').default ?? require('ioredis');
export const jose = require('jose');

export const BE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO = resolve(BE_DIR, '..');
export const DIST = join(BE_DIR, 'dist');
export const EVIDENCE_DIR = join(REPO, 'docs', 'agile', 'sso-idp', 'runs', '87-X6-drills', 'evidence');
export const MONGO_HOST = 'mongodb://127.0.0.1:27017';
export const MONGO_ADMIN_URI = `${MONGO_HOST}/?directConnection=true`;
export const DRILL_DB = /^vg-drill-(src|restore|rotate-local|rotate-vault)$/;
export const DRILL_REDIS_DBS = new Set([7, 8]);
export const DRILL_PORTS = new Set([4987, 4988]);
export const HTTP_TIMEOUT_MS = 5000;
export const BOOT_TIMEOUT_MS = 30_000;
/** fe-admin as `db:seed` creates it (seed.ts buildFeAdminClient). */
export const FE_ADMIN = { clientId: 'fe-admin', redirectUri: 'http://localhost:3000/auth/callback' };
export const ADMIN_SCOPE = 'openid offline_access admin.read admin.write';

export const dbUri = (db) => {
  if (!DRILL_DB.test(db)) throw new Error(`refusing database ${db}: not a drill database`);
  return `${MONGO_HOST}/${db}?directConnection=true`;
};
export const redisUri = (n) => {
  if (!DRILL_REDIS_DBS.has(n)) throw new Error(`refusing Redis db ${n}: only 7/8 are drill dbs`);
  return `redis://127.0.0.1:6379/${n}`;
};
export const hex = (n = 32) => randomBytes(n).toString('hex');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const now = () => Date.now();

/** Run log (step lines only, never secrets) + timer helper. */
export function makeLog() {
  const lines = [];
  const t0 = now();
  const log = (msg) => {
    const line = `[${((now() - t0) / 1000).toFixed(1)}s] ${msg}`;
    lines.push(line);
    console.log(line);
  };
  return { lines, log };
}
export async function timed(timings, key, fn) {
  const start = now();
  try {
    return await fn();
  } finally {
    timings[key] = now() - start;
  }
}

/** Throws unless every check passed; collects named results for the evidence. */
export function makeChecks() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    if (!ok) throw new Error(`check failed: ${name}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
  };
  return { results, check };
}

// ------------------------------------------------------------------ processes

/** Minimal explicit env for a child: nothing of this shell leaks in (no be/.env either, cwd is a temp dir). */
export function childEnv(vars) {
  return {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...vars,
  };
}

/** Every child process of this drill, so the time budget can kill them (DEBT-613). */
const children = new Set();
export const track = (child) => {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
};

/** Run a command to completion; output kept in memory only. */
export function run(cmd, args, { env, cwd, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = track(spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] }));
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** `node be/dist/<script>` with cwd = a temp dir (never be/, so be/.env is not loaded, D87.11). */
export const runDist = (script, args, env, cwd, opts = {}) =>
  run(process.execPath, [join(DIST, script), ...args], { env: childEnv(env), cwd, ...opts });

export function bash(script, args, env, opts = {}) {
  return run('bash', [script, ...args], { env: { ...process.env, MSYS_NO_PATHCONV: '1', ...env }, ...opts });
}

/** mongosh inside the shared container, script on argv via --eval (no file is copied into it). */
export function mongosh(uri, code, opts = {}) {
  return run('docker', ['exec', 'veyrigate-mongo', 'mongosh', uri, '--quiet', '--eval', code], {
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    ...opts,
  });
}

export async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), `vg-drill-${prefix}-`));
}
export const removeDir = (dir) => (dir ? rm(dir, { recursive: true, force: true }) : undefined);

/**
 * Idempotent stop of a child (DEBT-621): SIGTERM, SIGKILL after 10 s. "Has exited" is read from the child itself
 * (`exitCode`/`signalCode`): a signal kill exits with code null, which the old `exited = code` flag missed, so a
 * second stop() waited forever for an `exit` event that had already fired. Every call returns the same promise.
 */
export function stoppable(child) {
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const exited = gone() ? Promise.resolve() : new Promise((r) => child.once('exit', () => r()));
  let stopping;
  return {
    exited,
    gone,
    stop() {
      if (stopping) return stopping;
      if (gone()) return (stopping = Promise.resolve());
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
      return (stopping = exited.then(() => clearTimeout(t)));
    },
  };
}

/** Boot be/dist/main.js; resolves once /health and /ready answer 200 (<= 30 s). */
export async function startBe(name, port, env, cwd) {
  if (!DRILL_PORTS.has(port)) throw new Error(`refusing port ${port}`);
  const child = track(
    spawn(process.execPath, [join(DIST, 'main.js')], {
      env: childEnv({ ...env, PORT: String(port) }),
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  let tail = '';
  const keep = (d) => (tail = (tail + d).slice(-4000));
  child.stdout.setEncoding('utf8').on('data', keep);
  child.stderr.setEncoding('utf8').on('data', keep);
  const life = stoppable(child);
  const base = `http://127.0.0.1:${port}`;
  const deadline = now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (life.gone()) throw new Error(`${name} exited during boot (code ${child.exitCode ?? child.signalCode}); log tail withheld`);
    if (now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`${name} not ready within ${BOOT_TIMEOUT_MS} ms`);
    }
    try {
      const h = await http(`${base}/health`);
      const r = await http(`${base}/ready`);
      if (h.status === 200 && r.status === 200) break;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  return { base, child, stop: life.stop };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** BE env common to every drill instance (development mode: production needs https Vault + Secure cookies). */
export function beEnv({ port, db, redisDb, keyDir, extra = {} }) {
  return {
    NODE_ENV: 'development',
    ISSUER: `http://127.0.0.1:${port}`,
    MONGO_URI: dbUri(db),
    REDIS_URL: redisUri(redisDb),
    ACCESS_TOKEN_TTL: '900',
    REFRESH_TOKEN_TTL: '2592000',
    SESSION_IDLE_TTL: '3600',
    SESSION_ABSOLUTE_TTL: '86400',
    SESSION_COOKIE_SECURE: 'false',
    ...(keyDir ? { KEY_PROVIDER: 'local', KEY_LOCAL_DIR: keyDir } : {}),
    SMTP_URL: 'smtp://127.0.0.1:9', // nothing is mailed in a drill
    ADMIN_SEED_EMAIL: 'drill-admin@drill.invalid',
    CSRF_SECRET: hex(),
    RATE_LIMIT_WINDOW: '60',
    RATE_LIMIT_MAX: '100000',
    CLIENT_AUTH_FAIL_IP_MAX: '100000',
    CLIENT_AUTH_FAIL_CLIENT_MAX: '100000',
    ...extra,
  };
}

// ------------------------------------------------------------------ HTTP

export function http(url, { method = 'GET', headers = {}, body } = {}) {
  return fetch(url, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

export class CookieJar {
  constructor() {
    this.map = new Map();
  }
  take(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
      if (expired) this.map.delete(name);
      else this.map.set(name, value);
    }
    return res;
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const form = (o) => new URLSearchParams(o).toString();
const FORM = 'application/x-www-form-urlencoded';
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];

/**
 * Browser-equivalent authorization code + PKCE for a confidential client: /authorize -> /login ->
 * consent (approved) -> code -> /token. Returns the token response (in memory only).
 */
export async function codeFlow(base, { email, password, clientId, secret, redirectUri, scope, resource, jar = new CookieJar() }) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    resource,
    state: hex(8),
    nonce: hex(8),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'login',
  });
  let res = jar.take(await http(`${base}/authorize?${q}`, { headers: { cookie: jar.header() } }));
  let location = res.headers.get('location') ?? '';
  if (res.status !== 302 || !location.startsWith('/login')) throw new Error(`authorize: expected 302 /login, got ${res.status}`);
  const loginPage = jar.take(await http(`${base}${location}`, { headers: { cookie: jar.header() } }));
  const returnTo = new URL(location, base).searchParams.get('returnTo') ?? '/';
  const csrf = csrfOf(await loginPage.text());
  if (!csrf) throw new Error('login page has no CSRF field');
  res = jar.take(
    await http(`${base}/login`, {
      method: 'POST',
      headers: { cookie: jar.header(), 'content-type': FORM },
      body: form({ _csrf: csrf, email, password, returnTo }),
    }),
  );
  location = res.headers.get('location') ?? '';
  if (res.status !== 302 || !location.startsWith('/authorize')) throw new Error(`login: expected 302 /authorize, got ${res.status}`);
  res = jar.take(await http(`${base}${location}`, { headers: { cookie: jar.header() } }));
  if (res.status === 200) {
    const html = await res.text();
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
    const c2 = csrfOf(html);
    if (!requestId || !c2) throw new Error('consent page without request_id/_csrf');
    res = jar.take(
      await http(`${base}/authorize/consent`, {
        method: 'POST',
        headers: { cookie: jar.header(), 'content-type': FORM },
        body: form({ _csrf: c2, request_id: requestId, approve: 'true' }),
      }),
    );
  }
  location = res.headers.get('location') ?? '';
  const code = location.startsWith(redirectUri) ? new URL(location).searchParams.get('code') : null;
  if (res.status !== 302 || !code) throw new Error(`no code (status ${res.status})`);
  const tok = await http(`${base}/token`, {
    method: 'POST',
    headers: { authorization: basic(clientId, secret), 'content-type': FORM },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  if (tok.status !== 200) throw new Error(`token: ${tok.status}`);
  return { tokens: await tok.json(), jar };
}

export const refresh = (base, client, rt) =>
  http(`${base}/token`, {
    method: 'POST',
    headers: { authorization: basic(client.clientId, client.secret), 'content-type': FORM },
    body: form({ grant_type: 'refresh_token', refresh_token: rt }),
  });
export const bearer = (base, path, at, { method = 'GET', json } = {}) =>
  http(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${at}`, ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
export const introspect = (base, client, token) =>
  http(`${base}/introspect`, {
    method: 'POST',
    headers: { authorization: basic(client.clientId, client.secret), 'content-type': FORM },
    body: form({ token }),
  });

// ------------------------------------------------------------------ Mongo / Redis namespace

export async function mongoAdmin() {
  return mongoose.createConnection(MONGO_ADMIN_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
}
export async function listDbs(conn) {
  const r = await conn.db.admin().listDatabases({ nameOnly: true });
  return r.databases.map((d) => d.name);
}
/** Count-only fingerprint of a database someone else owns (must not change during a drill). */
export async function countsOf(conn, name) {
  const db = conn.getClient().db(name);
  const out = {};
  for (const c of (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).sort()) {
    out[c] = await db.collection(c).estimatedDocumentCount();
  }
  return out;
}

export async function portFree(port) {
  return new Promise((r) => {
    const s = netConnect({ host: '127.0.0.1', port }, () => {
      s.destroy();
      r(false);
    });
    s.on('error', () => r(true));
  });
}

/**
 * D87.11 namespace guard, BEFORE any write: drill dbs absent, Redis dbs empty, ports free, the e2e db
 * fingerprinted. Throws on any violation.
 */
export async function assertNamespace({ conn, dbs, redisDbs, ports }) {
  for (const d of dbs) if (!DRILL_DB.test(d)) throw new Error(`refusing database ${d}`);
  const present = await listDbs(conn);
  for (const d of dbs) if (present.includes(d)) throw new Error(`database ${d} already exists: clean it first`);
  for (const n of redisDbs) {
    const r = new IORedis(redisUri(n), { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await r.connect();
      const size = await r.dbsize();
      if (size !== 0) throw new Error(`Redis db ${n} is not empty (${size} keys)`);
    } finally {
      r.disconnect();
    }
  }
  for (const p of ports) if (!(await portFree(p))) throw new Error(`port ${p} is in use`);
  return { e2eBefore: present.includes('sso-idp-e2e') ? await countsOf(conn, 'sso-idp-e2e') : null };
}

/** Drop ONLY drill dbs, FLUSHDB ONLY drill Redis dbs (never FLUSHALL), then verify. */
export async function cleanupNamespace({ conn, dbs, redisDbs }) {
  const errors = [];
  for (const d of dbs) {
    if (!DRILL_DB.test(d)) continue;
    try {
      await conn.getClient().db(d).dropDatabase();
    } catch (e) {
      errors.push(`drop ${d}: ${e.message}`);
    }
  }
  for (const n of redisDbs) {
    const r = new IORedis(redisUri(n), { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await r.connect();
      await r.flushdb();
    } catch (e) {
      errors.push(`flushdb ${n}: ${e.message}`);
    } finally {
      r.disconnect();
    }
  }
  return errors;
}

export async function postCheck({ conn, redisDbs, e2eBefore }) {
  const left = (await listDbs(conn)).filter((d) => d.startsWith('vg-drill-'));
  const sizes = {};
  for (const n of redisDbs) {
    const r = new IORedis(redisUri(n), { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await r.connect();
      sizes[n] = await r.dbsize();
    } finally {
      r.disconnect();
    }
  }
  const e2eAfter = e2eBefore ? await countsOf(conn, 'sso-idp-e2e') : null;
  return {
    drillDbsLeft: left,
    redisDbSizes: sizes,
    e2eUnchanged: JSON.stringify(e2eBefore) === JSON.stringify(e2eAfter),
  };
}

// ------------------------------------------------------------------ digest

const { EJSON } = mongoose.mongo.BSON;
const indexSpec = (i) => ({
  name: i.name,
  key: i.key,
  ...(i.unique ? { unique: true } : {}),
  ...(i.expireAfterSeconds !== undefined ? { expireAfterSeconds: i.expireAfterSeconds } : {}),
  ...(i.partialFilterExpression ? { partialFilterExpression: i.partialFilterExpression } : {}),
});

/** Per collection: count, index specs, sha256 of canonical EJSON of the documents sorted by _id. */
export async function digestDb(conn, name) {
  const db = conn.getClient().db(name);
  const out = {};
  for (const c of (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).sort()) {
    const h = createHash('sha256');
    let count = 0;
    for await (const doc of db.collection(c).find({}).sort({ _id: 1 })) {
      h.update(EJSON.stringify(doc, { relaxed: false }));
      h.update('\n');
      count++;
    }
    const indexes = (await db.collection(c).indexes()).map(indexSpec).sort((a, b) => a.name.localeCompare(b.name));
    out[c] = { count, indexes, sha256: h.digest('hex') };
  }
  return out;
}

// ------------------------------------------------------------------ evidence

/**
 * Exposure check (D87.11): no JWT, no Argon2 hash, no key holding a password/secret value, and none of the
 * in-memory secret values of this run.
 */
export function assertClean(text, secrets) {
  const hits = [];
  if (/eyJ[A-Za-z0-9_-]{10,}/.test(text)) hits.push('jwt');
  if (/\$argon2/.test(text)) hits.push('argon2');
  if (/"[^"]*(password|secret)[^"]*"\s*:\s*"/i.test(text)) hits.push('password/secret key with a string value');
  if (/mongodb(\+srv)?:\/\/[^/\s"]*@/.test(text)) hits.push('credentialed URI');
  for (const s of secrets.filter((x) => typeof x === 'string' && x.length >= 8)) {
    if (text.includes(s)) hits.push('a secret value of this run');
  }
  if (hits.length) throw new Error(`evidence exposure check failed: ${[...new Set(hits)].join(', ')}`);
}

export function writeEvidence(drill, evidence, lines, secrets) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  const log = `${lines.join('\n')}\n`;
  assertClean(json, secrets);
  assertClean(log, secrets);
  if (!existsSync(EVIDENCE_DIR)) mkdirSync(EVIDENCE_DIR, { recursive: true });
  const base = join(EVIDENCE_DIR, `${drill}-${stamp}`);
  writeFileSync(`${base}.json`, json);
  writeFileSync(`${base}.log`, log);
  return `${base}.json`;
}

/**
 * Overall budget (D87.11: <= 10 min, DEBT-613): on expiry kill every child (BE instances, docker exec, bash), so
 * the pending step fails and `main` unwinds through its `finally` (cleanup + evidence). Never `process.exit`:
 * on Windows a child does not die with its parent and would keep the port and the Redis db.
 */
export function budget(ms) {
  const state = { expired: false };
  const t = setTimeout(() => {
    state.expired = true;
    process.exitCode = 2;
    console.error(`drill exceeded ${ms / 60000} min: killing its child processes`);
    for (const c of children) c.kill('SIGKILL');
  }, ms);
  t.unref();
  state.stop = () => clearTimeout(t);
  return state;
}

/**
 * One drill at a time on this host (both drills share Redis db 7 / port 4987): an exclusive lock file. A crash
 * leaves it behind; the message says which file to remove after checking no drill runs.
 */
export const LOCK_FILE = join(tmpdir(), 'vg-drill.lock');
export function acquireLock(drill) {
  try {
    const fd = openSync(LOCK_FILE, 'wx');
    writeFileSync(fd, `${drill} pid ${process.pid} ${new Date().toISOString()}\n`);
    closeSync(fd);
  } catch {
    throw new Error(`another drill holds ${LOCK_FILE} (remove it only if no drill is running)`);
  }
  return () => rmSync(LOCK_FILE, { force: true });
}

/** mongosh script on stdin as a FILE (`/dev/stdin`: a throw exits 1; REPL mode would go on), like runbook 4c. */
export function mongoshStdin(code, opts = {}) {
  return run('docker', ['exec', '-i', 'veyrigate-mongo', 'mongosh', '--nodb', '--quiet', '/dev/stdin'], {
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    input: code,
    ...opts,
  });
}
