import mongoose, { type ClientSession, type Connection, Types } from 'mongoose';
import { randomInt, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { validateEnv } from '../config/validation.schema';
import { SuperAdminGuard } from '../modules/identity/super-admin-guard';
import { DEFAULT_TENANT_ID } from '../modules/identity/tenant.service';
import { ADMIN_LOCKED_UNTIL, normalizeEmail, UserService } from '../modules/identity/user.service';
import { AuditAction } from '../modules/security/audit/audit-action.enum';
import { sanitizeMetadata } from '../modules/security/audit/audit.service';
import type { AuditEvent, AuditMetadata } from '../modules/security/audit/audit.types';
import { buildModels } from './mongo/models';
import { cliErrorText, mongoTarget } from './mongo/sync-indexes';

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
}

export interface RecoverIo {
  /** One line is read from it (the confirmation code). */
  input: Readable;
  /** One output line (stdout). */
  write: (line: string) => void;
  /** Confirmation wait; default 120 s. */
  timeoutMs?: number;
  now?: () => Date;
}

export type RefusalReason =
  | 'user_not_found'
  | 'super_admin_exists'
  | 'target_locked'
  | 'not_confirmed';

export type RecoverResult =
  | { status: 'recovered'; userId: string; eventId: string }
  | { status: 'refused'; reason: RefusalReason };

const NAME = /^[a-z0-9._-]{2,64}$/;
const TICKET = /^[A-Za-z0-9._#/-]{1,64}$/;
const VALUE_FLAGS = ['--email', '--requested-by', '--approved-by', '--ticket'] as const;
const SWITCHES = ['--unlock', '--allow-existing-super-admin', '--dry-run'] as const;

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

type UserRow = { _id: Types.ObjectId; lockedUntil?: Date };

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
  const metadata = (m: { unlocked: boolean; usableSuperAdmins: number }): AuditMetadata =>
    sanitizeMetadata({
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
  const user = await users.findOne({ email }, { _id: 1, lockedUntil: 1 }).lean<UserRow>().exec();
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
  io.write(`usable super_admins: ${usable}`);
  io.write(`requested by: ${args.requestedBy}, approved by: ${args.approvedBy}`);
  io.write(`ticket: ${args.ticket}`);
  io.write(
    `options: unlock=${args.unlock} allow-existing-super-admin=${args.allowExistingSuperAdmin}`,
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
  let result: { eventId: string; usable: number; unlocked: boolean };
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
      const event: AuditEvent = {
        ...baseAudit(userId),
        result: 'success',
        metadata: metadata({ unlocked, usableSuperAdmins: n }),
        eventId: randomUUID(),
        timestamp: now(),
      };
      await auditModel.create([event], { session });
      return { eventId: event.eventId, usable: n, unlocked };
    });
  } catch (err) {
    if (err instanceof Refusal) return refuse(err.reason, userId, err.usable);
    throw err;
  }
  io.write(`recovered: user ${userId}, audit event ${result.eventId}`);
  // The app's alert listener does not run here: the log pipeline alerts on this line.
  io.write(
    JSON.stringify({ alert: true, action: AuditAction.ADMIN_RECOVERED, eventId: result.eventId }),
  );
  return { status: 'recovered', userId, eventId: result.eventId };
}

async function main(): Promise<number> {
  const args = parseRecoverArgs(process.argv);
  const env = validateEnv(process.env);
  console.log(mongoTarget(env.MONGO_URI));
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
  try {
    const r = await recoverSuperAdmin(conn, args, {
      input: process.stdin,
      write: (line) => console.log(line),
    });
    return r.status === 'recovered' ? 0 : 1;
  } finally {
    await conn.close();
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
