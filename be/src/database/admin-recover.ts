import { ConfigService } from '@nestjs/config';
import mongoose, { type ClientSession, type Connection, Types } from 'mongoose';
import { randomInt, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { buildConfig } from '../config/configuration';
import { validateEnv } from '../config/validation.schema';
import { trustKey } from '../modules/authentication/login-throttle.service';
import { SuperAdminGuard } from '../modules/identity/super-admin-guard';
import { DEFAULT_TENANT_ID } from '../modules/identity/tenant.service';
import { ADMIN_LOCKED_UNTIL, normalizeEmail, UserService } from '../modules/identity/user.service';
import { AuditAction } from '../modules/security/audit/audit-action.enum';
import { sanitizeMetadata } from '../modules/security/audit/audit.service';
import type { AuditEvent, AuditMetadata } from '../modules/security/audit/audit.types';
import { SessionService } from '../modules/sessions/session.service';
import { buildModels } from './mongo/models';
import { cliErrorText, mongoTarget } from './mongo/sync-indexes';
import { createRedisClient } from './redis/redis.module';
import { RedisService } from './redis/redis.service';

/**
 * Production super_admin recovery (run 87, DEBT-252, D87.12–D87.14): `node dist/database/admin-recover.js`
 * with the APP's own env (`validateEnv`, any NODE_ENV). Grants `super_admin` (+ active membership) in
 * `default-tenant` to ONE existing user; never creates a user. Two different operator names + a
 * random code typed back after the plan is printed: a procedural control (D87.13), the real ones are
 * the two-person secret store, the audit written in the same transaction, and the alert line.
 */
export interface RecoverArgs {
  email: string;
  requestedBy: string;
  approvedBy: string;
  ticket: string;
  unlock: boolean;
  allowExistingSuperAdmin: boolean;
  dryRun: boolean;
  /**
   * Run 89 (D89.17): also remove the user's second factor and revoke every refresh family (same
   * transaction). Run 95 (DEBT-634, D95.2): then, after the commit, every Redis session + trusted
   * device of the user is revoked and the families are swept again (`RecoverIo.revokeSessions`).
   */
  resetMfa: boolean;
}

export interface RecoverIo {
  /** One line is read from it (the confirmation code). */
  input: Readable;
  /** One output line (stdout). */
  write: (line: string) => void;
  /** Confirmation wait; default 120 s. */
  timeoutMs?: number;
  now?: () => Date;
  /**
   * Run 95 (D95.4): ends every Redis session of the user, returns how many (`sessionRevoker`).
   * Called only with `--reset-mfa`, after the commit; absent then => counted as a failed revoke.
   */
  revokeSessions?: (userId: string) => Promise<number>;
  /** Bound of the Redis step; default 10 s (D95.3). */
  revokeTimeoutMs?: number;
}

export type RefusalReason =
  | 'user_not_found'
  | 'super_admin_exists'
  | 'target_locked'
  | 'not_confirmed';

/** Run 95 (D95.4): outcome of the post-commit session revoke (`--reset-mfa` only). */
export type SessionsOutcome = 'not_requested' | { revoked: number } | 'failed';

export type RecoverResult =
  | { status: 'recovered'; userId: string; eventId: string; sessions: SessionsOutcome }
  | { status: 'refused'; reason: RefusalReason };

const REVOKE_TIMEOUT_MS = 10_000;

const NAME = /^[a-z0-9._-]{2,64}$/;
const TICKET = /^[A-Za-z0-9._#/-]{1,64}$/;
const VALUE_FLAGS = ['--email', '--requested-by', '--approved-by', '--ticket'] as const;
const SWITCHES = ['--unlock', '--allow-existing-super-admin', '--dry-run', '--reset-mfa'] as const;

/** Allowlist parse of `process.argv`. Every error is a fixed text: no argument value is echoed. */
export function parseRecoverArgs(argv: readonly string[]): RecoverArgs {
  const args = argv.slice(2).filter((a) => a !== '--');
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((SWITCHES as readonly string[]).includes(a)) {
      if (switches.has(a)) throw new Error('argument repeated');
      switches.add(a);
    } else if ((VALUE_FLAGS as readonly string[]).includes(a)) {
      if (values.has(a)) throw new Error('argument repeated');
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error('argument without value');
      values.set(a, v);
      i++;
    } else {
      throw new Error(`unknown argument (allowed: ${[...VALUE_FLAGS, ...SWITCHES].join(' ')})`);
    }
  }
  const email = values.get('--email') ?? '';
  if (!email.trim() || email.length > 320) throw new Error('--email is required');
  const requestedBy = values.get('--requested-by') ?? '';
  const approvedBy = values.get('--approved-by') ?? '';
  if (!NAME.test(requestedBy)) throw new Error('--requested-by must match [a-z0-9._-]{2,64}');
  if (!NAME.test(approvedBy)) throw new Error('--approved-by must match [a-z0-9._-]{2,64}');
  if (requestedBy === approvedBy) throw new Error('--requested-by and --approved-by must differ');
  const ticket = values.get('--ticket') ?? '';
  if (!TICKET.test(ticket))
    throw new Error('--ticket is required and must match [A-Za-z0-9._#/-]{1,64}');
  return {
    email,
    requestedBy,
    approvedBy,
    ticket,
    unlock: switches.has('--unlock'),
    allowExistingSuperAdmin: switches.has('--allow-existing-super-admin'),
    dryRun: switches.has('--dry-run'),
    resetMfa: switches.has('--reset-mfa'),
  };
}

/** 8 digits shown as `1234-5678`. */
export function formatCode(n: number): string {
  const s = String(n).padStart(8, '0');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Read one line; null on EOF or timeout. */
function readLine(input: Readable, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, terminal: false });
    const done = (v: string | null) => {
      clearTimeout(timer);
      rl.removeAllListeners();
      rl.close();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    rl.once('line', (l) => done(l));
    rl.once('close', () => done(null));
  });
}

class Refusal extends Error {
  /** `usable` = the count seen inside the transaction (DEBT-619), recorded by the failure audit. */
  constructor(
    readonly reason: RefusalReason,
    readonly usable: number,
  ) {
    super(reason);
  }
}

type UserRow = { _id: Types.ObjectId; lockedUntil?: Date; mfa?: { enrolledAt?: Date } };

const SUPER_ADMINS = { tenantId: DEFAULT_TENANT_ID, status: 'active', roles: 'super_admin' };

/**
 * Usable super_admins of `default-tenant` OTHER than `targetId`, as `SuperAdminGuard` counts them:
 * active membership with `super_admin`, user present and not admin-locked.
 */
async function usableOthers(
  conn: Connection,
  targetId: Types.ObjectId,
  session?: ClientSession,
): Promise<number> {
  const rows = await conn
    .model('UserTenant')
    .find({ ...SUPER_ADMINS, userId: { $ne: targetId } }, { userId: 1 })
    .session(session ?? null)
    .lean<{ userId: Types.ObjectId }[]>()
    .exec();
  if (rows.length === 0) return 0;
  return conn
    .model('User')
    .countDocuments({
      _id: { $in: rows.map((r) => r.userId) },
      lockedUntil: { $ne: ADMIN_LOCKED_UNTIL },
    })
    .session(session ?? null)
    .exec();
}

/** Revoke every live refresh family of the user (stamp the family first, like `revokeAllForUser`). */
async function revokeFamilies(
  conn: Connection,
  userId: Types.ObjectId,
  at: Date,
  session?: ClientSession,
): Promise<void> {
  const families = conn.collection('refreshtokens');
  await families.updateMany(
    { userId, revokedAt: null },
    { $set: { familyRevokedAt: at } },
    session ? { session } : {},
  );
  await families.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: at } },
    session ? { session } : {},
  );
}

/** `op`, or a rejection after `ms` (the timer never keeps the process alive). */
async function bounded<T>(op: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const isAdminLocked = (u: UserRow) => u.lockedUntil?.getTime() === ADMIN_LOCKED_UNTIL.getTime();

/**
 * The CLI core (exported for the int spec). Refusals return `{status:'refused'}` after a
 * best-effort failure audit; a DB/transaction error throws and nothing was written.
 */
export async function recoverSuperAdmin(
  conn: Connection,
  args: RecoverArgs,
  io: RecoverIo,
): Promise<RecoverResult> {
  const now = io.now ?? (() => new Date());
  const users = conn.model('User');
  const memberships = conn.model('UserTenant');
  const auditModel = conn.model('AuditLog');
  const email = normalizeEmail(args.email);

  const baseAudit = (targetId?: string) => ({
    actorType: 'system' as const,
    actorId: args.requestedBy,
    tenantId: DEFAULT_TENANT_ID,
    action: AuditAction.ADMIN_RECOVERED,
    targetType: 'user',
    ...(targetId ? { targetId } : {}),
  });
  const metadata = (m: {
    unlocked: boolean;
    usableSuperAdmins: number;
    mfaReset?: boolean;
  }): AuditMetadata =>
    sanitizeMetadata({
      mfaReset: m.mfaReset ?? false,
      requestedBy: args.requestedBy,
      approvedBy: args.approvedBy,
      ticket: args.ticket,
      unlocked: m.unlocked,
      forced: args.allowExistingSuperAdmin && m.usableSuperAdmins > 0,
      usableSuperAdmins: m.usableSuperAdmins,
      host: hostname(),
    }) as AuditMetadata;

  const refuse = async (
    reason: RefusalReason,
    targetId: string | undefined,
    usable: number,
  ): Promise<RecoverResult> => {
    io.write(`refused: ${reason}`);
    const event: AuditEvent = {
      ...baseAudit(targetId),
      result: 'failure',
      reason,
      metadata: metadata({ unlocked: false, usableSuperAdmins: usable }),
      eventId: randomUUID(),
      timestamp: now(),
    };
    try {
      await auditModel.create(event);
    } catch {
      io.write('warning: the failure audit event could not be written');
    }
    return { status: 'refused', reason };
  };

  // Confused-deputy guard: the app DB always has its default tenant (created at boot).
  const tenants = conn.collection('tenants');
  if (!(await tenants.findOne({ id: DEFAULT_TENANT_ID }, { projection: { _id: 1 } }))) {
    throw new Error(`no tenant ${DEFAULT_TENANT_ID} in this database: wrong MONGO_URI?`);
  }

  // 1. Plan (read-only).
  io.write(`target: ${conn.host}:${conn.port}/${conn.name}`);
  // Native read: `mfa` is `select:false` in the schema, only its `enrolledAt` is projected.
  const user = await conn
    .collection('users')
    .findOne<UserRow>({ email }, { projection: { _id: 1, lockedUntil: 1, 'mfa.enrolledAt': 1 } });
  if (!user) return refuse('user_not_found', undefined, 0);
  const userId = user._id.toHexString();
  const member = await memberships
    .findOne({ userId: user._id, tenantId: DEFAULT_TENANT_ID }, { status: 1, roles: 1 })
    .lean<{ status: string; roles: string[] }>()
    .exec();
  const usable = await usableOthers(conn, user._id);
  const locked = isAdminLocked(user);
  io.write(`user: ${userId}`);
  io.write(
    `membership ${DEFAULT_TENANT_ID}: ${member ? `${member.status} [${member.roles.join(', ')}]` : 'none'}`,
  );
  io.write(`locked: ${locked ? 'yes (admin lock)' : 'no'}`);
  const enrolled = user.mfa?.enrolledAt != null;
  io.write(
    `mfa: ${enrolled ? 'enrolled' : 'not enrolled'}${args.resetMfa ? ' -> reset' : enrolled ? ' (kept)' : ''}`,
  );
  io.write(`usable super_admins: ${usable}`);
  io.write(`requested by: ${args.requestedBy}, approved by: ${args.approvedBy}`);
  io.write(`ticket: ${args.ticket}`);
  io.write(
    `options: unlock=${args.unlock} allow-existing-super-admin=${args.allowExistingSuperAdmin} reset-mfa=${args.resetMfa}`,
  );
  if (usable > 0 && !args.allowExistingSuperAdmin) {
    return refuse('super_admin_exists', userId, usable);
  }
  if (locked && !args.unlock) return refuse('target_locked', userId, usable);

  // 2. Two-person confirmation: the approver reads the plan aloud, then the code is typed back.
  const code = formatCode(randomInt(0, 100_000_000));
  io.write(`confirmation code: ${code}`);
  io.write(
    `approver: type the code to proceed (${Math.round((io.timeoutMs ?? 120_000) / 1000)} s)`,
  );
  const answer = await readLine(io.input, io.timeoutMs ?? 120_000);
  const typed = answer?.trim();
  if (typed !== code && typed !== code.replace('-', '')) {
    return refuse('not_confirmed', userId, usable);
  }

  // 3. One transaction: touch (serializes CLI ∥ CLI and CLI ∥ API demote/lock), re-check, write, audit.
  const guard = new SuperAdminGuard(conn, memberships as never, users as never);
  const userService = new UserService(users as never);
  let result: { eventId: string; usable: number; unlocked: boolean; mfaReset: boolean };
  try {
    result = await guard.runGuarded(async (session) => {
      const touched = await tenants.updateOne(
        { id: DEFAULT_TENANT_ID },
        { $inc: { superAdminGuard: 1 } },
        { session },
      );
      if (touched.matchedCount !== 1) throw new Error(`no tenant ${DEFAULT_TENANT_ID}`);
      await memberships
        .updateMany(SUPER_ADMINS, { $inc: { superAdminGuard: 1 } }, { session })
        .exec();
      const fresh = await users
        .findById(user._id, { _id: 1, lockedUntil: 1 })
        .session(session)
        .lean<UserRow>()
        .exec();
      if (!fresh) throw new Refusal('user_not_found', usable);
      const n = await usableOthers(conn, user._id, session);
      if (n > 0 && !args.allowExistingSuperAdmin) throw new Refusal('super_admin_exists', n);
      if (isAdminLocked(fresh) && !args.unlock) throw new Refusal('target_locked', n);
      await memberships
        .updateOne(
          { userId: user._id, tenantId: DEFAULT_TENANT_ID },
          {
            $set: { status: 'active' },
            $addToSet: { roles: 'super_admin' },
          },
          { upsert: true, session },
        )
        .exec();
      let unlocked = false;
      if (args.unlock && fresh.lockedUntil != null) {
        const r = await userService.adminUnlock(userId, true, now(), session);
        unlocked = r != null && r !== 'forbidden' && r.before.lockedUntil != null;
      }
      // Run 89 (D89.17): factor removed + every refresh family revoked (stamp first, like
      // `revokeAllForUser`), aborted with everything else if the audit insert fails.
      let mfaReset = false;
      if (args.resetMfa) {
        const at = now();
        const unset = await users
          .updateOne({ _id: user._id, mfa: { $exists: true } }, { $unset: { mfa: 1 } }, { session })
          .exec();
        mfaReset = unset.modifiedCount === 1;
        await revokeFamilies(conn, user._id, at, session);
      }
      const event: AuditEvent = {
        ...baseAudit(userId),
        result: 'success',
        metadata: metadata({ unlocked, usableSuperAdmins: n, mfaReset }),
        eventId: randomUUID(),
        timestamp: now(),
      };
      await auditModel.create([event], { session });
      return { eventId: event.eventId, usable: n, unlocked, mfaReset };
    });
  } catch (err) {
    if (err instanceof Refusal) return refuse(err.reason, userId, err.usable);
    throw err;
  }
  io.write(
    `recovered: user ${userId}, audit event ${result.eventId}${result.mfaReset ? ', mfa reset' : ''}`,
  );
  // The app's alert listener does not run here: the log pipeline alerts on this line.
  io.write(
    JSON.stringify({ alert: true, action: AuditAction.ADMIN_RECOVERED, eventId: result.eventId }),
  );
  const sessions = args.resetMfa
    ? await revokeAfterCommit(conn, user._id, result.eventId, args, io, now)
    : 'not_requested';
  return { status: 'recovered', userId, eventId: result.eventId, sessions };
}

/**
 * Run 95 (DEBT-634, D95.3-D95.6): after the commit, the same steps as the admin API revoke: Redis
 * sessions + trusted devices (`io.revokeSessions`, bounded), then a family sweep (a family `/token`
 * minted in between). Mongo is already committed: a failure is reported (fixed line, failure audit,
 * `'failed'` => exit 3), never thrown. Output lines carry no email and no error detail (URI).
 */
async function revokeAfterCommit(
  conn: Connection,
  userId: Types.ObjectId,
  recoveredEventId: string,
  args: RecoverArgs,
  io: RecoverIo,
  now: () => Date,
): Promise<SessionsOutcome> {
  const at = now();
  let failedStep: 'sessions' | 'sweep' | undefined;
  let count = 0;
  try {
    if (!io.revokeSessions) throw new Error('no session revoker');
    count = await bounded(
      io.revokeSessions(userId.toHexString()),
      io.revokeTimeoutMs ?? REVOKE_TIMEOUT_MS,
    );
  } catch {
    failedStep = 'sessions';
  }
  try {
    await revokeFamilies(conn, userId, at);
  } catch {
    failedStep ??= 'sweep';
  }
  io.write(
    failedStep === 'sessions'
      ? 'warning: recovered, but sessions were NOT revoked (redis): see runbook-ops section 11'
      : failedStep === 'sweep'
        ? `warning: recovered, sessions revoked: ${count}, but refresh families were NOT swept (sweep): see runbook-ops section 11`
        : `sessions revoked: ${count}`,
  );
  const event: AuditEvent = {
    actorType: 'system',
    actorId: args.requestedBy,
    tenantId: DEFAULT_TENANT_ID,
    action: AuditAction.SESSION_REVOKED,
    targetType: 'user',
    targetId: userId.toHexString(),
    ...(failedStep
      ? {
          result: 'failure' as const,
          reason: 'revoke_failed',
          metadata: { scope: 'all', via: 'admin_recover', recoveredEventId, failedStep },
        }
      : {
          result: 'success' as const,
          metadata: { scope: 'all', via: 'admin_recover', recoveredEventId, count },
        }),
    eventId: randomUUID(),
    timestamp: now(),
  };
  try {
    await conn.model('AuditLog').create(event);
  } catch {
    io.write('warning: the session revoke audit event could not be written');
  }
  return failedStep ? 'failed' : { revoked: count };
}

/** D95.5: 0 recovered (with `--reset-mfa`: sessions revoked too), 1 refused, 3 committed but not revoked. */
export function exitCodeOf(r: RecoverResult): 0 | 1 | 3 {
  if (r.status !== 'recovered') return 1;
  return r.sessions === 'failed' ? 3 : 0;
}

/**
 * Run 95 (D95.3): the CLI's session revoker, built from the shared classes without a Nest context:
 * `createRedisClient` (commandTimeout, maxRetriesPerRequest 1, Sentinel) + `SessionService`
 * (`revokeAllForUser`: Lua delete + `sess_end` tombstones + index). The client is created on the
 * first call only; then the trusted devices are forgotten best-effort (`write` gets a fixed line).
 * `close()` must always run: ioredis keeps reconnecting otherwise.
 */
export function sessionRevoker(
  config: ConfigService,
  write: (line: string) => void,
): { revokeSessions: (userId: string) => Promise<number>; close: () => void } {
  let redis: RedisService | undefined;
  return {
    revokeSessions: async (userId) => {
      redis ??= new RedisService(createRedisClient(config));
      const client = redis.client;
      try {
        return await new SessionService(redis, config).revokeAllForUser(userId);
      } finally {
        await client
          .del(trustKey(userId))
          .catch(() => write('warning: trusted devices were not forgotten (redis)'));
      }
    },
    close: () => redis?.client.disconnect(),
  };
}

async function main(): Promise<number> {
  const args = parseRecoverArgs(process.argv);
  const env = validateEnv(process.env);
  console.log(mongoTarget(env.MONGO_URI));
  if (args.resetMfa) {
    console.log('mfa: reset (factor removed, refresh families revoked)');
    console.log('sessions: revoked in Redis after commit');
  }
  if (args.dryRun) {
    console.log('dry-run: no connection made');
    return 0;
  }
  const conn = await mongoose
    .createConnection(env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 5000 })
    .asPromise();
  for (const { name, schema } of buildModels(env.AUDIT_RETENTION_DAYS)) {
    if (!conn.models[name]) conn.model(name, schema);
  }
  const write = (line: string) => console.log(line);
  // D95.2: only `--reset-mfa` touches Redis; otherwise no client is ever created.
  const revoker = args.resetMfa
    ? sessionRevoker(new ConfigService(buildConfig(env)), write)
    : undefined;
  try {
    const r = await recoverSuperAdmin(conn, args, {
      input: process.stdin,
      write,
      ...(revoker ? { revokeSessions: revoker.revokeSessions } : {}),
    });
    return exitCodeOf(r);
  } finally {
    revoker?.close();
    // After a commit the computed exit code (0/3) must stand: a failing close is only reported.
    await conn.close().catch(() => console.log('warning: closing the Mongo connection failed'));
  }
}

// `require` is undefined when imported under ESM (Jest); the built CLI is CJS.
if (typeof require !== 'undefined' && require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`admin-recover failed: ${cliErrorText(err, process.env.MONGO_URI)}`);
      process.exit(1);
    },
  );
}
