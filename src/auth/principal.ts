/**
 * Napoleon has no user accounts. It is a service, so an organization is reached
 * by API key and nothing else — which removes sessions, refresh tokens, roles
 * and password resets from the whole application.
 */

export type ApiKeyScope = 'ADMIN' | 'READ';

/** What the guard attaches to the request. */
export interface Principal {
  organizationId: string;
  apiKeyId: string;
  /** The key's label, useful in logs. */
  keyName: string;
  scope: ApiKeyScope;
}

/** Prefix of every key this service issues. */
export const KEY_PREFIX = 'sk_napoleon_';

/** Characters of the plaintext stored for display, enough to identify a key. */
export const KEY_PREFIX_LENGTH = 16;
