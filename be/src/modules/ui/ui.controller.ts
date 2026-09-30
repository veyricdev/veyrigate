import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { generateToken } from '../../common/crypto/crypto.util';
import type { AppConfig, SessionConfig } from '../../config/configuration';
import { AuthenticationService } from '../authentication/authentication.service';
import { normalizeEmail } from '../identity/user.service';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import { RateLimitService } from '../security/rate-limit/rate-limit.service';
import { SESSION_COOKIE, SessionCookie } from '../sessions/session.cookie';
import { SessionService } from '../sessions/session.service';
import { CsrfGuard, CsrfService } from './csrf.service';
import { HtmlExceptionFilter } from './html-exception.filter';
import { safeReturnTo } from './return-to';

class FormDto {
  @IsOptional() @IsString() _csrf?: string;
}
class LoginDto extends FormDto {
  @IsEmail() email!: string;
  @IsString() @Length(8, 128) password!: string;
  @IsOptional() @IsString() returnTo?: string;
}
class RegisterDto extends LoginDto {}
class EmailDto extends FormDto {
  @IsEmail() email!: string;
}
class TokenDto extends FormDto {
  @IsString() token!: string;
}
class ResetDto extends TokenDto {
  @IsString() @Length(8, 128) password!: string;
}

interface UiRequest {
  cookies?: Record<string, string>;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  id?: string;
}
interface UiReply {
  view(template: string, data: Record<string, unknown>): unknown;
  redirect(url: string, status?: number): unknown;
  setCookie(name: string, value: string, options: object): unknown;
  clearCookie(name: string, options: object): unknown;
}

const ANON_COOKIE = 'idp_csrf';

@Controller()
@UseFilters(HtmlExceptionFilter)
export class UiController {
  private readonly issuer: string;
  private readonly secure: boolean;
  constructor(
    private readonly auth: AuthenticationService,
    private readonly csrf: CsrfService,
    private readonly sessions: SessionService,
    private readonly sessionCookie: SessionCookie,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
    this.secure = config.getOrThrow<SessionConfig>('session').cookieSecure;
  }

  @Get('/') async home(@Req() req: UiRequest, @Res() reply: UiReply) {
    if (!(await this.hasLiveSession(req, reply))) return reply.redirect('/login', 302);
    return reply.view('message.eta', {
      title: 'Signed in',
      message: 'You are signed in.',
      actionUrl: '/logout',
      actionLabel: 'Sign out',
    });
  }
  @Get('/login') async login(
    @Req() req: UiRequest,
    @Res() reply: UiReply,
    @Query('returnTo') returnTo?: string,
  ) {
    if (await this.hasLiveSession(req, reply)) return reply.redirect('/', 302);
    return this.form(req, reply, 'login.eta', {
      title: 'Sign in',
      returnTo: safeReturnTo(returnTo, this.issuer),
    });
  }
  @Get('/register') async register(@Req() req: UiRequest, @Res() reply: UiReply) {
    if (await this.hasLiveSession(req, reply)) return reply.redirect('/', 302);
    return this.form(req, reply, 'register.eta', { title: 'Create account' });
  }
  @Get('/forgot') forgot(@Req() req: UiRequest, @Res() reply: UiReply) {
    return this.form(req, reply, 'forgot.eta', { title: 'Reset password' });
  }
  @Get('/verify-email') verifyForm(
    @Req() req: UiRequest,
    @Res() reply: UiReply,
    @Query('token') token = '',
  ) {
    return this.form(req, reply, 'verify.eta', { title: 'Verify email', token });
  }
  @Get('/reset') resetForm(
    @Req() req: UiRequest,
    @Res() reply: UiReply,
    @Query('token') token = '',
  ) {
    return this.form(req, reply, 'reset.eta', { title: 'Choose a new password', token });
  }
  @Get('/consent') consent(@Req() req: UiRequest, @Res() reply: UiReply) {
    return this.form(req, reply, 'consent.eta', { title: 'Consent' });
  }
  @Get('/logout') logoutForm(@Req() req: UiRequest, @Res() reply: UiReply) {
    return this.form(req, reply, 'logout.eta', { title: 'Sign out' });
  }

  @Post('/register')
  @UseGuards(CsrfGuard)
  async registerPost(@Body() body: RegisterDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    await this.limit('register', req, body.email);
    await this.auth.register(normalizeEmail(body.email), body.password);
    return reply.view('message.eta', {
      title: 'Check your email',
      message: 'If the address can be registered, a verification email has been sent.',
    });
  }
  @Post('/login')
  @UseGuards(CsrfGuard)
  async loginPost(@Body() body: LoginDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    await this.limit('login', req, body.email);
    const established = await this.auth.login(normalizeEmail(body.email), body.password, {
      oldSessionId: this.sessionCookie.read(req),
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      requestId: req.id,
    });
    this.sessionCookie.set(reply, established.id);
    return reply.redirect(safeReturnTo(body.returnTo, this.issuer), 302);
  }
  @Post('/forgot')
  @UseGuards(CsrfGuard)
  async forgotPost(@Body() body: EmailDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    await this.limit('forgot', req, body.email);
    await this.auth.forgotPassword(normalizeEmail(body.email));
    return reply.view('message.eta', {
      title: 'Check your email',
      message: 'If the account exists, a reset email has been sent.',
    });
  }
  @Post('/verify-email')
  @UseGuards(CsrfGuard)
  async verifyPost(@Body() body: TokenDto, @Res() reply: UiReply) {
    await this.auth.verifyEmail(body.token);
    return reply.view('message.eta', {
      title: 'Email verified',
      message: 'Your email has been verified.',
    });
  }
  @Post('/reset')
  @UseGuards(CsrfGuard)
  async resetPost(@Body() body: ResetDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    await this.limit('reset', req, body.token);
    await this.auth.resetPassword(body.token, body.password);
    return reply.view('message.eta', {
      title: 'Password changed',
      message: 'Your password has been changed.',
    });
  }
  @Post('/logout')
  @HttpCode(302)
  @UseGuards(CsrfGuard)
  async logout(@Body() _body: FormDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    const id = this.sessionCookie.read(req);
    if (id) {
      const session = await this.sessions.get(id);
      await this.sessions.revoke(id);
      if (session)
        await this.audit.record({
          actorType: 'user',
          actorId: session.userId,
          action: AuditAction.SESSION_REVOKED,
          targetType: 'session',
          targetId: session.ref,
          result: 'success',
        });
    }
    this.sessionCookie.clear(reply);
    return reply.redirect('/login?loggedOut=1', 302);
  }

  private form(req: UiRequest, reply: UiReply, template: string, data: Record<string, unknown>) {
    const identity = this.identity(req, reply);
    return reply.view(template, { ...data, csrf: this.csrf.token(identity) });
  }
  private async hasLiveSession(req: UiRequest, reply: UiReply): Promise<boolean> {
    const id = this.sessionCookie.read(req);
    if (!id) return false;
    if (await this.sessions.get(id)) return true;
    this.sessionCookie.clear(reply);
    delete req.cookies?.[SESSION_COOKIE];
    return false;
  }
  private identity(req: UiRequest, reply?: UiReply): string {
    const session = this.sessionCookie.read(req);
    if (session) return session;
    let anon = req.cookies?.[ANON_COOKIE];
    if (!anon) {
      if (!reply) throw new BadRequestException('Invalid form submission.');
      anon = generateToken();
      reply.setCookie(ANON_COOKIE, anon, {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.secure,
        path: '/',
      });
    }
    return anon;
  }
  private async limit(name: string, req: UiRequest, account?: string) {
    const result = await this.rateLimit.hit(
      { name },
      { ip: req.ip, account, deviceId: req.cookies?.[ANON_COOKIE] },
    );
    if (!result.allowed)
      throw new HttpException({ retryAfter: result.retryAfterSec }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
