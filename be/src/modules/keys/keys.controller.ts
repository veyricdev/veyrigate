import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { KEY_PROVIDER, type KeyProvider, type PublicJwk } from './key-provider';
import type { HttpRequest } from '../../common/http/http.types';
import { applyCors, requestOrigin } from '../clients/client-cors.helper';
import { ClientCorsService } from '../clients/client-cors.service';

/** Reply members the JWKS controller needs (Fastify, structural). */
interface JwksReply {
  status(code: number): JwksReply;
  header(name: string, value: string): JwksReply;
  send(payload: unknown): unknown;
}

@Controller()
export class KeysController {
  constructor(
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    private readonly cors: ClientCorsService,
  ) {}

  /**
   * Public keys only (INV-19). A browser SPA may fetch JWKS to verify tokens client-side, so the
   * response echoes a registered Origin (union allowlist - JWKS has no client context); the
   * payload itself is fully public, so this only enables `fetch` to read it cross-origin.
   */
  @Get('jwks.json')
  async jwks(@Req() req: HttpRequest, @Res() reply: JwksReply): Promise<unknown> {
    // Always `Vary: Origin` (even with no Origin): JWKS is cached, so a shared cache must not serve
    // a stored no-Origin copy (no ACAO) to a later CORS request.
    const origin = requestOrigin(req);
    applyCors(
      reply,
      origin,
      origin ? await this.cors.isOriginRegisteredForAnyClient(origin) : false,
    );
    return reply
      .status(200)
      .send({ keys: await this.keys.getPublicKeys() } as { keys: PublicJwk[] });
  }
}
