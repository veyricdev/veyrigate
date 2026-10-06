import { Module } from '@nestjs/common';
import { ClientAuthenticationService } from './client-authentication.service';
import { ClientCorsService } from './client-cors.service';
import { ClientCredentialService } from './client-credential.service';
import { ClientService } from './client.service';

/** Clients + ClientCredential + client authentication + dynamic CORS (B3.1, B3.3, B3.4). */
@Module({
  providers: [
    ClientService,
    ClientCredentialService,
    ClientAuthenticationService,
    ClientCorsService,
  ],
  exports: [ClientService, ClientCredentialService, ClientAuthenticationService, ClientCorsService],
})
export class ClientsModule {}
