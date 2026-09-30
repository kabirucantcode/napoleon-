import { Module } from '@nestjs/common';
import { HealthController } from './app.controller';
import { AccessModule } from './auth/access.module';
import { DatabaseModule } from './database/database.module';
import { IngestModule } from './modules/ingest.module';
import { IntelligenceModule } from './modules/intelligence.module';

/**
 * Napoleon — standalone operational intelligence.
 *
 * Four modules and no more:
 *
 *   DatabaseModule     the only database this app knows about
 *   AccessModule       API keys, scopes, one authentication path
 *   IntelligenceModule read surfaces (insights, metrics, scoring, OpenAI)
 *   IngestModule       writing operational records in
 *
 * Nothing here imports from, or depends on, any other application. Point
 * DATABASE_URL at a fresh Postgres and `npm run bootstrap`, and it runs.
 */
@Module({
  imports: [
    DatabaseModule,
    AccessModule,
    IntelligenceModule,
    IngestModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
