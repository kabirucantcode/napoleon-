import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Napoleon owns its database outright — there is no shared connection with any
 * other application. Connection failures are fatal on purpose: a service that
 * boots but cannot read its data returns confident, wrong answers.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Connected to the database');
    } catch (err) {
      this.logger.error(
        `Cannot reach the database. Check DATABASE_URL. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
