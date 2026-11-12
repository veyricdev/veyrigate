import { formatCode, parseRecoverArgs } from './admin-recover';

/** Run 87 T2 (DEBT-252, D87.12): argument allowlist of `admin-recover` (AC5, AC10). */
const argv = (...args: string[]) => ['node', 'admin-recover.js', ...args];
const OK = [
  '--email',
  'Ops.Admin@Example.com',
  '--requested-by',
  'alice',
  '--approved-by',
  'bob.sec',
  '--ticket',
  'INC-42',
];

describe('admin-recover parseRecoverArgs', () => {
  it('parses the required flags and defaults the options to false', () => {
    expect(parseRecoverArgs(argv(...OK))).toEqual({
      email: 'Ops.Admin@Example.com',
      requestedBy: 'alice',
      approvedBy: 'bob.sec',
      ticket: 'INC-42',
      unlock: false,
      allowExistingSuperAdmin: false,
      dryRun: false,
    });
  });

  it('accepts the three switches and pnpm `--`', () => {
    expect(
      parseRecoverArgs(argv('--', ...OK, '--unlock', '--allow-existing-super-admin', '--dry-run')),
    ).toMatchObject({ unlock: true, allowExistingSuperAdmin: true, dryRun: true });
  });

  it.each([
    ['same requester and approver', ['--approved-by', 'alice'], /must differ/],
    ['approver differing only by case is the same person', ['--approved-by', 'ALICE'], /./],
    ['missing --ticket', ['--ticket', undefined], /--ticket/],
    ['ticket outside its pattern', ['--ticket', 'INC 42;rm'], /--ticket/],
    ['requester outside its pattern', ['--requested-by', 'a'], /--requested-by/],
    ['approver outside its pattern', ['--approved-by', 'Bob Smith'], /--approved-by/],
    ['missing --email', ['--email', undefined], /--email/],
  ])('%s => throws', (_name, [flag, value], msg) => {
    const args = [...OK];
    const i = args.indexOf(flag as string);
    if (value === undefined) args.splice(i, 2);
    else args[i + 1] = value as string;
    expect(() => parseRecoverArgs(argv(...args))).toThrow(msg as RegExp);
  });

  it.each([
    ['an unknown flag', [...OK, '--force']],
    ['a typo of a switch', [...OK, '--dry-run=true']],
    ['a flag repeated', [...OK, '--ticket', 'INC-43']],
    ['a flag without value', [...OK.slice(0, 7)]],
    ['a stray positional', [...OK, 'extra']],
  ])('%s => throws without echoing any value', (_name, args) => {
    let message = '';
    try {
      parseRecoverArgs(argv(...args));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    for (const v of ['Ops.Admin@Example.com', 'INC-43', 'extra', '--dry-run=true', '--force']) {
      expect(message).not.toContain(v);
    }
  });

  it('formats the confirmation code as 4-4 digits', () => {
    expect(formatCode(1234)).toBe('0000-1234');
    expect(formatCode(98765432)).toBe('9876-5432');
  });
});
