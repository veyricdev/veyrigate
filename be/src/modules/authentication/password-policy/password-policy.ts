import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** ASVS 6.2.4 asks for at least the top 3000; the embedded list has 10 000 (D85.4). */
const MIN_ENTRIES = 3000;
/** Product words a user must not build a password from (ASVS 6.2.11). */
const CONTEXT_WORDS = ['veyrigate', 'sso-idp', 'ssoidp'];
/** Shortest email local part treated as a context word (shorter ones match too much). */
const MIN_LOCAL_PART = 4;

export const PASSWORD_LENGTH_MESSAGE = 'Password must be between 8 and 128 characters.';
export const COMMON_PASSWORD_MESSAGE = 'Choose a less common password.';

// Built output (CJS): next to this file in `dist/`, copied by the nest-cli assets rule. Jest runs
// the TS sources as native ESM without `__dirname`: resolve from the package root (`be/`) instead.
const DEFAULT_LIST =
  typeof __dirname === 'string'
    ? join(__dirname, 'common-passwords.txt')
    : join(process.cwd(), 'src/modules/authentication/password-policy/common-passwords.txt');

/**
 * Load the common-password list (one lowercase NFKC entry per line, LF). Throws when the file is
 * missing, unreadable or holds fewer than 3000 entries: the caller (module import) then fails, so
 * the app never starts without the list (fail-closed).
 */
export function loadCommonPasswords(path: string = DEFAULT_LIST): ReadonlySet<string> {
  const entries = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  const set = new Set(entries);
  if (set.size < MIN_ENTRIES) {
    throw new Error(`Common-password list has ${set.size} entries (need >= ${MIN_ENTRIES})`);
  }
  return set;
}

/** Loaded once at import: a missing/broken list stops the boot (D85.4). */
const COMMON = loadCommonPasswords();

/**
 * Password policy for every password a user chooses (register, reset, change; never login/seed):
 * 8–128 characters, not in the common list, not built from product words or the user's email
 * (DEBT-574, ASVS 6.2.1/6.2.4/6.2.11). Compared on NFKC + lowercase. Throws a 400 with a fixed
 * sentence that never echoes the password.
 */
export function assertAcceptablePassword(password: string, ctx: { email?: string } = {}): void {
  if (password.length < 8 || password.length > 128) {
    throw new BadRequestException(PASSWORD_LENGTH_MESSAGE);
  }
  const folded = password.normalize('NFKC').toLowerCase();
  const email = ctx.email?.normalize('NFKC').toLowerCase();
  const local = email?.split('@')[0] ?? '';
  if (
    COMMON.has(folded) ||
    CONTEXT_WORDS.some((word) => folded.includes(word)) ||
    (local.length >= MIN_LOCAL_PART && folded.includes(local)) ||
    (email !== undefined && folded === email)
  ) {
    throw new BadRequestException(COMMON_PASSWORD_MESSAGE);
  }
}
