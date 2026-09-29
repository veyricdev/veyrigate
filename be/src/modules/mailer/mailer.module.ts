import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig, MailerConfig } from '../../config/configuration';
import { MAILER } from './mailer';
import { SmtpMailer } from './smtp.mailer';

@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { smtpUrl } = config.getOrThrow<MailerConfig>('mailer');
        const { issuer } = config.getOrThrow<AppConfig>('app');
        return new SmtpMailer(smtpUrl, `no-reply@${new URL(issuer).hostname}`);
      },
    },
  ],
  exports: [MAILER],
})
export class MailerModule {}
