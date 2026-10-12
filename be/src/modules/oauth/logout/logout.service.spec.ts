import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { ClientService } from '../../clients/client.service';
import type { TokenVerifier } from '../../keys/token-verifier';
import { LogoutService, type LogoutParams } from './logout.service';

const ISSUER = 'https://issuer.example';
const DEFAULT = '/login?loggedOut=1';

type ClientStub = {
  clientId: string;
  postLogoutRedirectUris: string[];
  frontchannelLogoutUri?: string;
};

describe('LogoutService (B4.7)', () => {
  const clientsByEoId: Record<string, ClientStub> = {};
  const clients = {
    findByClientId: jest.fn(async (id: string) => clientsByEoId[id] ?? null),
  } as unknown as ClientService;
  const verifier = {
    verifyIdTokenHint: jest.fn<TokenVerifier['verifyIdTokenHint']>(),
  } as unknown as jest.Mocked<Pick<TokenVerifier, 'verifyIdTokenHint'>>;
  const config = {
    getOrThrow: () => ({ issuer: ISSUER }),
  } as unknown as ConfigService;

  let service: LogoutService;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(clientsByEoId)) delete clientsByEoId[k];
    clientsByEoId.rp1 = {
      clientId: 'rp1',
      postLogoutRedirectUris: ['https://rp1.example/out'],
      frontchannelLogoutUri: 'https://rp1.example/fc',
    };
    clientsByEoId.rp2 = {
      clientId: 'rp2',
      postLogoutRedirectUris: [],
      frontchannelLogoutUri: 'https://rp2.example/fc',
    };
    clientsByEoId.rp3 = { clientId: 'rp3', postLogoutRedirectUris: ['https://rp3.example/out'] };
    service = new LogoutService(clients, verifier as unknown as TokenVerifier, config);
  });

  const hintOf = (clientId: string, sub = 'user-1') =>
    (verifier.verifyIdTokenHint as jest.Mock).mockResolvedValue({ sub, aud: clientId } as never);

  describe('resolvePostLogoutRedirect', () => {
    const params = (over: Partial<LogoutParams> = {}): LogoutParams => ({
      idTokenHint: 'HINT',
      postLogoutRedirectUri: 'https://rp1.example/out',
      ...over,
    });

    it('returns the exact-matched URI when hint + uri + session user all agree', async () => {
      hintOf('rp1');
      expect(await service.resolvePostLogoutRedirect(params(), 'user-1')).toBe(
        'https://rp1.example/out',
      );
    });

    it('appends a capped, encoded state', async () => {
      hintOf('rp1');
      const out = await service.resolvePostLogoutRedirect(params({ state: 'a b&c' }), 'user-1');
      expect(out).toBe('https://rp1.example/out?state=a+b%26c');
    });

    it('drops a state longer than 512 chars', async () => {
      hintOf('rp1');
      const out = await service.resolvePostLogoutRedirect(
        params({ state: 'x'.repeat(513) }),
        'user-1',
      );
      expect(out).toBe('https://rp1.example/out');
    });

    it('falls back to default without a hint', async () => {
      expect(
        await service.resolvePostLogoutRedirect(
          { postLogoutRedirectUri: 'https://rp1.example/out' },
          'user-1',
        ),
      ).toBe(DEFAULT);
    });

    it('falls back when the hint does not verify (forged/garbage)', async () => {
      (verifier.verifyIdTokenHint as jest.Mock).mockRejectedValue(new Error('bad') as never);
      expect(await service.resolvePostLogoutRedirect(params(), 'user-1')).toBe(DEFAULT);
    });

    it('falls back when the URI is not an exact match (open-redirect guard)', async () => {
      hintOf('rp1');
      expect(
        await service.resolvePostLogoutRedirect(
          params({ postLogoutRedirectUri: 'https://rp1.example/out/' }),
          'user-1',
        ),
      ).toBe(DEFAULT);
    });

    it('falls back when the URI belongs to a different client than the hint', async () => {
      hintOf('rp3'); // rp3 registers rp3.example/out; hint points at rp3 but URI is rp1`s
      expect(
        await service.resolvePostLogoutRedirect(
          params({ postLogoutRedirectUri: 'https://rp1.example/out' }),
          'user-1',
        ),
      ).toBe(DEFAULT);
    });

    it('falls back when a query client_id disagrees with the hint aud', async () => {
      hintOf('rp1');
      expect(await service.resolvePostLogoutRedirect(params({ clientId: 'rp2' }), 'user-1')).toBe(
        DEFAULT,
      );
    });

    it('falls back when the live session user is not the hint subject', async () => {
      hintOf('rp1', 'someone-else');
      expect(await service.resolvePostLogoutRedirect(params(), 'user-1')).toBe(DEFAULT);
    });

    it('accepts when there is no live session (sub check skipped)', async () => {
      hintOf('rp1', 'whoever');
      expect(await service.resolvePostLogoutRedirect(params(), undefined)).toBe(
        'https://rp1.example/out',
      );
    });
  });

  // QA (run 16): `verifyHint` is a public method but was only exercised indirectly through
  // `resolvePostLogoutRedirect`. Cover it directly, including the fail-closed branch where the hint
  // verifies but the asserted client no longer exists (deleted client → null, no redirect).
  describe('verifyHint (QA — direct)', () => {
    it('returns { clientId, sub, client } when the hint verifies and the client still exists', async () => {
      hintOf('rp1', 'user-9');
      expect(await service.verifyHint('HINT')).toEqual({
        clientId: 'rp1',
        sub: 'user-9',
        client: clientsByEoId.rp1,
      });
    });

    it('returns null when the hint verifies but the asserted client was deleted (fail-closed)', async () => {
      // Valid signature/iss, but `aud` points at a client that no longer exists in the store.
      (verifier.verifyIdTokenHint as jest.Mock).mockResolvedValue({
        sub: 'user-1',
        aud: 'gone-client',
      } as never);
      expect(await service.verifyHint('HINT')).toBeNull();
    });

    it('returns null (swallows) when verification throws (forged / expired-fail / garbage)', async () => {
      (verifier.verifyIdTokenHint as jest.Mock).mockRejectedValue(
        new Error('bad signature') as never,
      );
      expect(await service.verifyHint('HINT')).toBeNull();
    });
  });

  describe('frontchannelIframes / frameSrcOrigins', () => {
    it('builds one iframe per registered front-channel RP with iss, de-duplicated', async () => {
      const iframes = await service.frontchannelIframes(['rp1', 'rp2', 'rp2', 'rp3']);
      expect(iframes).toEqual([
        `https://rp1.example/fc?iss=${encodeURIComponent(ISSUER)}`,
        `https://rp2.example/fc?iss=${encodeURIComponent(ISSUER)}`,
      ]);
    });

    it('skips unknown clients and clients without a front-channel URI', async () => {
      expect(await service.frontchannelIframes(['rp3', 'nope'])).toEqual([]);
    });

    it('frameSrcOrigins returns scheme+host origins, de-duplicated', async () => {
      const origins = service.frameSrcOrigins([
        'https://rp1.example/fc?iss=x',
        'https://rp1.example/other',
        'https://rp2.example/fc',
      ]);
      expect(origins).toEqual(['https://rp1.example', 'https://rp2.example']);
    });

    // QA (run 16, Task 4 invariant): the result feeds a CSP `frame-src` directive, so NO returned
    // origin may carry a `;`, `,` or whitespace that could inject/terminate a directive. Feed a
    // spread of real registered-style URIs (incl. non-default ports and userinfo/query noise) and
    // assert every origin is a clean scheme+host[:port] token — the joined directive is
    // injection-free. This locks the sink's exposure budget independent of registration-time checks.
    it('frameSrcOrigins yields only injection-safe origins for a directive (CSP sink)', () => {
      const origins = service.frameSrcOrigins([
        'https://rp1.example/fc?iss=x',
        'https://rp2.example:8443/fc',
        'https://rp2.example:8443/other',
        'https://rp3.example/fc#frag',
      ]);
      expect(origins).toEqual([
        'https://rp1.example',
        'https://rp2.example:8443',
        'https://rp3.example',
      ]);
      // No origin may contain a CSP directive separator / whitespace.
      for (const o of origins) expect(o).not.toMatch(/[;,\s]/);
      // The built directive carries exactly the allowlisted origins, nothing smuggled after a `;`.
      expect(`frame-src ${origins.join(' ')}`).toBe(
        'frame-src https://rp1.example https://rp2.example:8443 https://rp3.example',
      );
    });
  });
});
