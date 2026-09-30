import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { SCOPE_METADATA_KEY } from './require-scope.decorator';
import type { ApiKeyScope, Principal } from './principal';

interface AuthenticatableRequest {
  headers?: Record<string, string | string[] | undefined>;
  principal?: Principal;
}

/**
 * API-key authentication.
 *
 * Two transports, one credential, because different callers send it
 * differently:
 *
 *   X-API-Key: sk_napoleon_…             explicit, used by your own services
 *   Authorization: Bearer sk_napoleon_…  what an OpenAI-compatible client sends
 *
 * Keys are compared by sha256, so the plaintext never reaches the database and a
 * dump of the table is not a set of usable credentials.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatableRequest>();

    const raw =
      this.readHeader(req, 'x-api-key') ?? extractBearer(req.headers?.authorization);
    if (!raw) {
      throw new UnauthorizedException(
        'Missing API key. Send it as `X-API-Key: sk_napoleon_…` or `Authorization: Bearer sk_napoleon_…`.',
      );
    }

    const keyHash = createHash('sha256').update(raw).digest('hex');
    const key = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: { organization: { select: { isActive: true } } },
    });

    if (!key || !key.isActive || !key.organization?.isActive) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    const principal: Principal = {
      organizationId: key.organizationId,
      apiKeyId: key.id,
      keyName: key.name,
      scope: key.scope as ApiKeyScope,
    };
    req.principal = principal;

    const required = this.reflector.getAllAndOverride<ApiKeyScope>(
      SCOPE_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required === 'ADMIN' && principal.scope !== 'ADMIN') {
      throw new ForbiddenException(
        `This route requires an ADMIN key; the one supplied is ${principal.scope}.`,
      );
    }

    // Usage tracking must never block or fail the request.
    this.prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch((err) =>
        this.logger.warn(
          `Could not record API key usage: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );

    return true;
  }

  private readHeader(
    req: AuthenticatableRequest,
    name: string,
  ): string | null {
    const value = req.headers?.[name];
    if (typeof value === 'string' && value) return value;
    // A repeated header arrives as an array; take the first.
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return null;
  }
}

function extractBearer(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
