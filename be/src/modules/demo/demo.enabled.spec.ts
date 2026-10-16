import { isDemoEnabled } from './demo.enabled';

/**
 * The demo allowlist (Q-24.2 / DEBT-098): `development`/`test` enable the demo resource; everything
 * else — including an UNSET `NODE_ENV` and `production` — keeps it OFF (fail-closed). This reads
 * the RAW env, so a zod-defaulted `app.nodeEnv` can never fool it.
 */
describe('isDemoEnabled (raw NODE_ENV allowlist)', () => {
  it('enables for development and test only', () => {
    expect(isDemoEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isDemoEnabled({ NODE_ENV: 'test' })).toBe(true);
  });

  it('disables for production, unset, and any other value (fail-closed)', () => {
    expect(isDemoEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(isDemoEnabled({})).toBe(false); // NODE_ENV unset => OFF (not fail-open)
    expect(isDemoEnabled({ NODE_ENV: 'staging' })).toBe(false);
    expect(isDemoEnabled({ NODE_ENV: '' })).toBe(false);
  });
});
