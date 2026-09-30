import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Principal } from './principal';

/** Reads the principal `ApiKeyGuard` attached. Only valid on guarded routes. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const request = ctx.switchToHttp().getRequest<{ principal?: Principal }>();
    return request.principal as Principal;
  },
);
