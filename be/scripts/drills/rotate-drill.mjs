#!/usr/bin/env node
// Emergency signing-key rotation drill (run 87 T3, D87.16). Reproduce with:
//   pnpm -C be build && node be/scripts/drills/rotate-drill.mjs --provider local [--dry-run]
//   VAULT_TEST_ADDR=http://127.0.0.1:18200 VAULT_TEST_ROOT_TOKEN=$T node be/scripts/drills/rotate-drill.mjs --provider vault
// local: one BE (port 4987, DB vg-drill-rotate-local, Redis db 7, temp KEY_LOCAL_DIR).
// vault: two BEs A/B (4987/4988) on DB vg-drill-rotate-vault + Redis db 8, Vault Transit mount vg-drill-transit set up
// like runbook-deploy section 8 (policy from ops/vault/idp-signer.hcl, app token in a 0600 file of a temp dir).
// The root token is only read from the environment; never printed, never written. Evidence = HTTP codes, kids,
// timings (ms from the rotate request), tool versions; no token. --dry-run checks tools + namespace only.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADMIN_SCOPE, DIST, FE_ADMIN, REPO, acquireLock, assertNamespace, beEnv, bearer, budget, cleanupNamespace, codeFlow, hex, http,
  introspect, jose, makeChecks, makeLog, mongoAdmin, now, postCheck, refresh, removeDir, run, runDist, sleep,
  startBe, tempDir, writeEvidence,
} from './lib.mjs';

const argv = process.argv.slice(2);
const pi = argv.indexOf('--provider');
const provider = pi >= 0 ? argv[pi + 1] : undefined;
const dryRun = argv.includes('--dry-run');
const known = new Set(['--provider', 'local', 'vault', '--dry-run']);
if (!['local', 'vault'].includes(provider) || argv.some((a) => !known.has(a))) {
  console.error('usage: rotate-drill.mjs --provider local|vault [--dry-run]');
  process.exit(1);
}
const VAULT = provider === 'vault';
const DB = VAULT ? 'vg-drill-rotate-vault' : 'vg-drill-rotate-local';
const REDIS_DB = VAULT ? 8 : 7;
const PORTS = VAULT ? [4987, 4988] : [4987];
const A = 'http://127.0.0.1:4987';
const B = 'http://127.0.0.1:4988';
const ISSUER = A; // both instances are the same IdP
const ADMIN_EMAIL = 'drill-admin@drill.invalid';
const RESOURCE = `${ISSUER}/admin/`;
const MOUNT = 'vg-drill-transit';
const KEY = 'idp-signer';
const POLICY = 'vg-drill-idp-signer';
const ADDR = process.env.VAULT_TEST_ADDR;
const ROOT = process.env.VAULT_TEST_ROOT_TOKEN;
const WITHIN_MS = 32_000; // JWKS metadata cache 30 s + margin (runbook-deploy section 8)

async function vault(method, path, body, token = ROOT) {
  const res = await fetch(`${ADDR}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** Poll `fn` until it returns true; ms elapsed since `t0`, or null after `limit`. */
async function until(t0, limit, fn) {
  for (;;) {
    if (await fn()) return now() - t0;
    if (now() - t0 > limit) return null;
    await sleep(250);
  }
}

const kidsOf = async (base) => (await (await http(`${base}/jwks.json`)).json()).keys.map((k) => k.kid);
const rotations = async (base, metricsToken) => {
  const text = await (await http(`${base}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } })).text();
  const m = /^sso_signing_key_rotations_total\{[^}]*mode="emergency"[^}]*result="success"[^}]*\} (\d+)/m.exec(text);
  return m ? Number(m[1]) : 0;
};
const verifies = async (jwks, token) => {
  try {
    await jose.jwtVerify(token, jwks, { issuer: ISSUER });
    return true;
  } catch {
    return false;
  }
};

async function main() {
  const { lines, log } = makeLog();
  const { results, check } = makeChecks();
  const timings = {};
  const secrets = [ROOT];
  const evidence = { drill: `rotate-${provider}`, startedAt: new Date().toISOString(), checks: results, timings };
  if (VAULT && (!ADDR || !ROOT)) throw new Error('vault: set VAULT_TEST_ADDR and VAULT_TEST_ROOT_TOKEN (see be/test/vault-preflight.mjs)');
  const conn = await mongoAdmin();
  const ns = { conn, dbs: [DB], redisDbs: [REDIS_DB] };
  let e2eBefore = null;
  let work;
  let mounted = false;
  const bes = [];
  let owned = false; // set only once the lock AND every guard (Vault + namespace) passed (senior 1)
  let releaseLock;
  const timer = budget(10 * 60_000);
  try {
    releaseLock = acquireLock(`rotate-${provider}`);
    if (VAULT && (await vault('GET', 'sys/health')).status !== 200) throw new Error('Vault is not healthy');
    if (VAULT && (await vault('GET', `sys/mounts/${MOUNT}`)).status === 200) throw new Error(`mount ${MOUNT} already exists`);
    ({ e2eBefore } = await assertNamespace({ ...ns, ports: PORTS }));
    owned = !dryRun;
    log(`namespace ok: ${DB} absent; redis db ${REDIS_DB} empty; ports ${PORTS.join('/')} free`);
    if (dryRun) {
      log('dry-run: tools and namespace ok, nothing written');
      return;
    }
    work = await tempDir(`rot-${provider}`);
    const cwd = join(work, 'cwd');
    mkdirSync(cwd);
    let keyDir;
    let providerEnv;
    if (VAULT) {
      check('vault: mount', (await vault('POST', `sys/mounts/${MOUNT}`, { type: 'transit' })).status === 204);
      mounted = true;
      const created = await vault('POST', `${MOUNT}/keys/${KEY}`, { type: 'rsa-2048', exportable: false, allow_plaintext_backup: false });
      check('vault: key rsa-2048 exportable=false', created.status === 200 || created.status === 204);
      const hcl = readFileSync(join(REPO, 'ops', 'vault', 'idp-signer.hcl'), 'utf8').replaceAll('<mount>', MOUNT).replaceAll('<key>', KEY);
      check('vault: policy from ops/vault/idp-signer.hcl', (await vault('PUT', `sys/policies/acl/${POLICY}`, { policy: hcl })).status === 204);
      const tok = await vault('POST', 'auth/token/create', { policies: [POLICY], ttl: '1h', no_default_policy: true });
      const appToken = tok.body.auth?.client_token;
      check('vault: app token', !!appToken);
      secrets.push(appToken);
      const tokenFile = join(work, 'vault-token');
      writeFileSync(tokenFile, appToken, { mode: 0o600 });
      providerEnv = { KEY_PROVIDER: 'vault', VAULT_ADDR: ADDR, VAULT_TOKEN_FILE: tokenFile, VAULT_TRANSIT_MOUNT: MOUNT, VAULT_TRANSIT_KEY: KEY };
    } else {
      keyDir = join(work, 'keys');
      mkdirSync(keyDir);
    }
    const metricsToken = hex();
    const adminPassword = hex(16);
    secrets.push(metricsToken, adminPassword);
    const env = beEnv({ port: 4987, db: DB, redisDb: REDIS_DB, keyDir, extra: { ...providerEnv, KEY_PREPUBLISH_SEC: '600', METRICS_TOKEN: metricsToken } });
    env.ISSUER = ISSUER;
    secrets.push(env.CSRF_SECRET);
    const seed = await runDist('database/seed.js', [], { ...env, NODE_ENV: 'test', ADMIN_SEED_EMAIL: ADMIN_EMAIL, ADMIN_SEED_PASSWORD: adminPassword }, cwd);
    check('db:seed exit 0', seed.code === 0);
    const secret = /fe-admin client_secret \(shown once\): (\S+)/.exec(seed.stdout)?.[1];
    check('fe-admin secret issued', !!secret);
    secrets.push(secret);
    const client = { clientId: FE_ADMIN.clientId, secret };
    const flow = { email: ADMIN_EMAIL, password: adminPassword, ...client, redirectUri: FE_ADMIN.redirectUri, scope: ADMIN_SCOPE, resource: RESOURCE };

    bes.push(await startBe('be-a', 4987, env, cwd));
    if (VAULT) bes.push(await startBe('be-b', 4988, env, cwd));
    const login = async () => {
      const t = (await codeFlow(A, flow)).tokens;
      secrets.push(t.access_token, t.refresh_token, t.id_token);
      return t;
    };

    // AC1: before the rotation.
    const old = await login();
    const keysBefore = (await (await bearer(A, '/admin/keys', old.access_token)).json()).items;
    const oldKid = keysBefore.find((k) => k.status === 'active')?.kid;
    check('one active key before', !!oldKid);
    check('AT_old: /userinfo 200', (await bearer(A, '/userinfo', old.access_token)).status === 200);
    check('AT_old: /introspect active', (await (await introspect(A, client, old.access_token)).json()).active === true);
    if (VAULT) check('AT_old: /userinfo on B 200 (B cache warm)', (await bearer(B, '/userinfo', old.access_token)).status === 200);
    const warm = jose.createRemoteJWKSet(new URL(`${A}/jwks.json`));
    check('RP verifier (warm cache) accepts AT_old', await verifies(warm, old.access_token));
    const metricBefore = await rotations(A, metricsToken);

    // AC2: emergency rotation.
    const t0 = now();
    const rot = await bearer(A, '/admin/keys/rotate', old.access_token, { method: 'POST', json: { mode: 'emergency' } });
    timings.rotateLatencyMs = now() - t0;
    const rotBody = await rot.json();
    check('POST /admin/keys/rotate emergency => 200', rot.status === 200, rot.status);
    const newKid = rotBody.newKid;
    check('new kid differs', newKid && newKid !== oldKid);

    // AC3: JWKS only the new kid (A at once, B within 32 s), no-cache.
    const jwksA = await http(`${A}/jwks.json`);
    const kidsA = (await jwksA.json()).keys.map((k) => k.kid);
    timings.jwksAOnlyNewMs = now() - t0;
    check('JWKS A = [newKid] at once', JSON.stringify(kidsA) === JSON.stringify([newKid]), kidsA);
    check('JWKS cache-control no-cache', jwksA.headers.get('cache-control') === 'no-cache');
    if (VAULT) {
      timings.jwksBOnlyNewMs = await until(t0, WITHIN_MS, async () => JSON.stringify(await kidsOf(B)) === JSON.stringify([newKid]));
      check('JWKS B = [newKid] within 32 s', timings.jwksBOnlyNewMs !== null, timings.jwksBOnlyNewMs);
      timings.userinfoB401Ms = await until(t0, WITHIN_MS, async () => (await bearer(B, '/userinfo', old.access_token)).status === 401);
      check('AT_old on B /userinfo 401 within 32 s', timings.userinfoB401Ms !== null, timings.userinfoB401Ms);
    }

    // AC4: AT_old is dead at the IdP.
    check('AT_old: /userinfo 401', (await bearer(A, '/userinfo', old.access_token)).status === 401);
    check('AT_old: /introspect active:false', (await (await introspect(A, client, old.access_token)).json()).active === false);
    check('AT_old: admin API 401', (await bearer(A, '/admin/keys', old.access_token)).status === 401);

    // AC9/AC10 right after the emergency rotation (before the normal one adds a pending key).
    if (VAULT) {
      const meta = (await vault('GET', `${MOUNT}/keys/${KEY}`)).body.data;
      const n = meta.latest_version;
      evidence.vaultKey = { latest_version: n, min_decryption_version: meta.min_decryption_version, min_encryption_version: meta.min_encryption_version, min_available_version: meta.min_available_version, versions: Object.keys(meta.keys) };
      check('Vault: latest = min_decryption = min_encryption = min_available, one version left',
        meta.min_decryption_version === n && meta.min_encryption_version === n && meta.min_available_version === n && Object.keys(meta.keys).length === 1, evidence.vaultKey);
    } else {
      const files = readdirSync(keyDir).sort();
      evidence.keyDirFiles = files;
      check('KEY_LOCAL_DIR = keys.json + <newKid>.pem only (runbook-deploy section 6)', JSON.stringify(files) === JSON.stringify([`${newKid}.pem`, 'keys.json'].sort()), files);
    }

    // AC5/AC6: refresh => new kid; fresh verifier vs warm verifier.
    const rr = await refresh(A, client, old.refresh_token);
    const fresh = await rr.json();
    secrets.push(fresh.access_token, fresh.refresh_token, fresh.id_token);
    check('refresh after emergency => 200', rr.status === 200, rr.status);
    check('new AT kid = newKid', jose.decodeProtectedHeader(fresh.access_token).kid === newKid);
    const cold = jose.createRemoteJWKSet(new URL(`${A}/jwks.json`));
    check('new RP verifier accepts the new AT', await verifies(cold, fresh.access_token));
    check('new RP verifier rejects AT_old', !(await verifies(cold, old.access_token)));
    evidence.warmVerifier = {
      acceptsAtOld: await verifies(warm, old.access_token), // runbook-ops section 1 step 5(ii): RP caches keep the old key
      acceptsNewAtImmediately: await verifies(warm, fresh.access_token), // jose cooldownDuration 30 s
      msSinceRotate: now() - t0,
    };
    log(`warm RP verifier: ${JSON.stringify(evidence.warmVerifier)}`);

    // AC7: audit + metric.
    const adm = await login();
    const audit = await (await bearer(A, '/admin/audit?action=SIGNING_KEY_ROTATED', adm.access_token)).json();
    const ev = (audit.items ?? []).find((e) => e.result === 'success' && e.metadata?.mode === 'emergency');
    check('audit SIGNING_KEY_ROTATED success mode emergency', !!ev);
    const metricAfter = await rotations(A, metricsToken);
    evidence.metric = { before: metricBefore, after: metricAfter };
    check('sso_signing_key_rotations_total{mode=emergency,result=success} +1', metricAfter === metricBefore + 1, evidence.metric);
    const keysAfter = (await (await bearer(A, '/admin/keys', adm.access_token)).json()).items;
    check('GET /admin/keys: exactly one active, the new kid', keysAfter.filter((k) => k.status === 'active').map((k) => k.kid).join() === newKid);

    // AC8: normal => pending; normal again => 409.
    const n1 = await bearer(A, '/admin/keys/rotate', adm.access_token, { method: 'POST', json: { mode: 'normal' } });
    const n1b = await n1.json();
    const pending = (await (await bearer(A, '/admin/keys', adm.access_token)).json()).items.filter((k) => k.status === 'pending');
    check('normal rotation => 200 + one pending key', n1.status === 200 && pending.length === 1 && pending[0].kid === n1b.newKid);
    const n2 = await bearer(A, '/admin/keys/rotate', adm.access_token, { method: 'POST', json: { mode: 'normal' } });
    const n2b = await n2.json();
    check('second normal rotation while pending => 409 conflict', n2.status === 409 && n2b.error === 'conflict');

    evidence.kids = { oldKid, newKid, pendingKid: n1b.newKid };
    evidence.tools = { node: process.version, head: (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO })).stdout.trim(), dist: DIST.replace(REPO, '<repo>') };
    evidence.limits = 'BE runs NODE_ENV=development (production: https Vault + Secure cookies, covered by docker-smoke.sh); KEY_PREPUBLISH_SEC=600, ACCESS_TOKEN_TTL=900 as in production.';
  } catch (err) {
    evidence.error = timer.expired ? `time budget exceeded (${err.message})` : err.message;
  } finally {
    timer.stop();
    for (const b of bes) await b.stop().catch(() => undefined);
    if (owned) {
      evidence.cleanupErrors = await cleanupNamespace(ns);
      if (mounted) {
        await vault('DELETE', `sys/policies/acl/${POLICY}`).catch(() => undefined);
        await vault('DELETE', `sys/mounts/${MOUNT}`).catch(() => undefined);
      }
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
      console.error(`rotate drill REFUSED (nothing touched): ${evidence.error}`);
      process.exitCode = 1;
    }
    return;
  }
  evidence.ok = !evidence.error && results.every((r) => r.ok) && evidence.postCheck.drillDbsLeft.length === 0 &&
    Object.values(evidence.postCheck.redisDbSizes).every((n) => n === 0) && evidence.postCheck.e2eUnchanged;
  const path = writeEvidence(`rotate-${provider}`, evidence, lines, secrets.filter(Boolean));
  log(`evidence: ${path}`);
  if (!evidence.ok) {
    console.error(`rotate drill FAILED${evidence.error ? `: ${evidence.error}` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`rotate drill FAILED: ${err.message}`);
  process.exitCode = 1;
});
