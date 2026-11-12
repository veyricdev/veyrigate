import type { ConfigService } from '@nestjs/config';
import { buildKeyProvider } from './keys.module';
import { LocalKeyProvider } from './local-key-provider';
import { VaultTransitKeyProvider } from './vault-transit-key-provider';

/** Run 86 (DEBT-393, D86.9/D86.10): the factory passes KEY_PREPUBLISH_SEC to either provider. */
describe('buildKeyProvider (KEY_PROVIDER factory)', () => {
  const config = (provider: 'local' | 'vault', prepublishSec: number) =>
    ({
      getOrThrow: (key: string) =>
        ({
          keys: {
            provider,
            prepublishSec,
            localDir: './unused-keys',
            vault:
              provider === 'vault'
                ? {
                    addr: 'http://vault.unit.test:8200',
                    tokenFile: '/unused',
                    mount: 'transit',
                    key: 'k',
                    timeoutMs: 2000,
                  }
                : undefined,
          },
          app: { nodeEnv: 'test' },
          token: { accessTokenTtl: 900 },
        })[key],
    }) as unknown as ConfigService;

  it.each([0, 600, 86400])('local gets prepublishSec %p from config', (sec) => {
    const p = buildKeyProvider(config('local', sec));
    expect(p).toBeInstanceOf(LocalKeyProvider);
    expect(p.prepublishSec).toBe(sec);
  });

  it.each([0, 600, 86400])('vault gets prepublishSec %p from config', (sec) => {
    const p = buildKeyProvider(config('vault', sec));
    expect(p).toBeInstanceOf(VaultTransitKeyProvider);
    expect(p.prepublishSec).toBe(sec);
  });

  it('local is refused in production', () => {
    const cfg = config('local', 0);
    const prod = {
      getOrThrow: (key: string) =>
        key === 'app' ? { nodeEnv: 'production' } : cfg.getOrThrow(key),
    } as unknown as ConfigService;
    expect(() => buildKeyProvider(prod)).toThrow(/dev-only/);
  });
});
