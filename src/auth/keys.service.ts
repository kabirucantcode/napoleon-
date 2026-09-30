import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import {
  KEY_PREFIX,
  KEY_PREFIX_LENGTH,
  type ApiKeyScope,
} from './principal';

/**
 * Issues and revokes organization API keys.
 *
 * The plaintext is returned exactly once, at creation. Only its sha256 is
 * stored, so a lost key is replaced rather than recovered — which is the
 * trade-off that makes a database dump useless to an attacker.
 */
@Injectable()
export class KeysService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    organizationId: string,
    name: string,
    scope: ApiKeyScope,
  ) {
    const plaintext = `${KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(plaintext).digest('hex');

    const key = await this.prisma.apiKey.create({
      data: {
        organizationId,
        name,
        scope,
        keyHash,
        prefix: plaintext.slice(0, KEY_PREFIX_LENGTH),
      },
    });

    return {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      scope: key.scope,
      apiKey: plaintext,
      warning: 'Store this key now. It cannot be retrieved again.',
    };
  }

  /** Prefixes and metadata only — never the secret, which is not stored. */
  async list(organizationId: string) {
    return this.prisma.apiKey.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        scope: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Revokes one key. Refuses to revoke the key making the request, because
   * doing so would lock the caller out of their own organization with no way
   * back in except re-running `npm run bootstrap`.
   */
  async revoke(
    organizationId: string,
    keyId: string,
    requestingKeyId: string,
  ) {
    if (keyId === requestingKeyId) {
      throw new ConflictException(
        'Refusing to revoke the key you are authenticating with. Create a replacement first, then revoke this one.',
      );
    }

    const key = await this.prisma.apiKey.findFirst({
      where: { id: keyId, organizationId },
      select: { id: true },
    });
    if (!key) throw new NotFoundException('API key not found');

    await this.prisma.apiKey.update({
      where: { id: keyId },
      data: { isActive: false },
    });

    return { success: true, id: keyId };
  }
}
