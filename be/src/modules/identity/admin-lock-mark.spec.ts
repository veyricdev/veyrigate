import { nextAdminLockMark } from './user.service';

describe('nextAdminLockMark (run 57, DEBT-420)', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');

  it('no previous mark => now', () => {
    expect(nextAdminLockMark(undefined, now).getTime()).toBe(now.getTime());
  });

  it('previous mark before now => now', () => {
    expect(nextAdminLockMark(new Date(now.getTime() - 5), now).getTime()).toBe(now.getTime());
  });

  it('previous mark at or after now => previous + 1 ms', () => {
    expect(nextAdminLockMark(now, now).getTime()).toBe(now.getTime() + 1);
    const ahead = new Date(now.getTime() + 40);
    expect(nextAdminLockMark(ahead, now).getTime()).toBe(ahead.getTime() + 1);
  });
});
