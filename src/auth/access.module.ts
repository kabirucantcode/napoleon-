import { Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { KeysController } from './keys.controller';
import { KeysService } from './keys.service';

/**
 * Access control for the whole API. Exported so every other module can attach
 * `ApiKeyGuard` without re-declaring it — there is exactly one authentication
 * path in this application.
 */
@Module({
  controllers: [KeysController],
  providers: [ApiKeyGuard, KeysService],
  exports: [ApiKeyGuard, KeysService],
})
export class AccessModule {}
