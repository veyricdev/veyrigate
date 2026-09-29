import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitService, type RateLimitRule } from './rate-limit.service';

const RATE_LIMIT_META = 'rateLimit';

export interface RateLimitOptions extends RateLimitRule {
  /** Body field carrying the account identifier (e.g. `email`). */
  accountField?: string;
}

interface RequestLike {
  ip?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface ReplyLike {
  header(name: string, value: string): unknown;
}

/**
 * `@RateLimit({ name: 'login', accountField: 'email' })` — limits the endpoint
 * by IP, account (body field) and device (`x-device-id` header, see tasks A3).
 * Over the limit → 429 with `Retry-After`.
 */
export function RateLimit(options: RateLimitOptions): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(RATE_LIMIT_META, options), UseGuards(RateLimitGuard));
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_META,
      [context.getHandler(), context.getClass()],
    );
    if (!options) {
      return true;
    }
    const http = context.switchToHttp();
    const req = http.getRequest<RequestLike>();

    const body = (req.body ?? {}) as Record<string, unknown>;
    const accountValue = options.accountField ? body[options.accountField] : undefined;
    const device = req.headers['x-device-id'];

    const result = await this.rateLimit.hit(options, {
      ip: req.ip,
      account: typeof accountValue === 'string' ? accountValue : undefined,
      deviceId: typeof device === 'string' ? device : undefined,
    });
    if (!result.allowed) {
      http.getResponse<ReplyLike>().header('Retry-After', String(result.retryAfterSec));
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
