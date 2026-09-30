import { SetMetadata } from '@nestjs/common';
import type { ApiKeyScope } from './principal';

export const SCOPE_METADATA_KEY = 'napoleon:requiredScope';

/**
 * Require a scope on a route. `ApiKeyGuard` compares this against the key's
 * scope. Routes without this decorator accept any valid key.
 *
 * Used to keep READ keys read-only: a leaked read-only key should not be able to
 * rewrite operational data or mint new credentials.
 */
export const RequireScope = (scope: ApiKeyScope) =>
  SetMetadata(SCOPE_METADATA_KEY, scope);
