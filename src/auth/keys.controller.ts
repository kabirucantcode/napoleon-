import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { CurrentPrincipal } from './current-principal.decorator';
import { RequireScope } from './require-scope.decorator';
import { KeysService } from './keys.service';
import type { ApiKeyScope, Principal } from './principal';

const MAX_NAME_LENGTH = 80;
const SCOPES: ApiKeyScope[] = ['ADMIN', 'READ'];

/**
 * Key management. ADMIN-only, so a leaked READ key cannot mint itself an ADMIN
 * replacement — privilege escalation has to be impossible, not just unlikely.
 */
@Controller('keys')
@UseGuards(ApiKeyGuard)
@RequireScope('ADMIN')
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  /** Issues a key. The plaintext is in the response exactly once. */
  @Post()
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: Record<string, unknown>,
  ) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      throw new BadRequestException(
        '`name` is required so you can tell this key apart after it is issued.',
      );
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new BadRequestException(
        `\`name\` must be at most ${MAX_NAME_LENGTH} characters.`,
      );
    }

    const rawScope = body?.scope;
    if (rawScope !== undefined && !SCOPES.includes(rawScope as ApiKeyScope)) {
      throw new BadRequestException(
        `\`scope\` must be one of ${SCOPES.join(', ')}.`,
      );
    }
    // Default to the least privilege that is still useful.
    const scope: ApiKeyScope = (rawScope as ApiKeyScope) ?? 'READ';

    return this.keys.create(principal.organizationId, name, scope);
  }

  @Get()
  list(@CurrentPrincipal() principal: Principal) {
    return this.keys.list(principal.organizationId);
  }

  @Delete(':id')
  revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ) {
    return this.keys.revoke(
      principal.organizationId,
      id,
      principal.apiKeyId,
    );
  }
}
