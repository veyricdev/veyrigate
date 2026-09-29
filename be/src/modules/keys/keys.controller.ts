import { Controller, Get, Inject } from '@nestjs/common';
import { KEY_PROVIDER, type KeyProvider, type PublicJwk } from './key-provider';

@Controller()
export class KeysController {
  constructor(@Inject(KEY_PROVIDER) private readonly keys: KeyProvider) {}

  /** Public keys only (INV-19). */
  @Get('jwks.json')
  async jwks(): Promise<{ keys: PublicJwk[] }> {
    return { keys: await this.keys.getPublicKeys() };
  }
}
