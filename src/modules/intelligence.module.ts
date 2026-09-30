import { Module } from '@nestjs/common';
import { AccessModule } from '../auth/access.module';
import { InsightsService } from '../engine/insights.service';
import { OpenAiRenderer } from '../openai/openai.renderer';
import { AnalyzeController } from './analyze.controller';
import { ConversationsService } from './conversations.service';
import { InsightsController } from './insights.controller';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { OpenAiController } from './openai.controller';

/**
 * Everything a caller reads: the structured insights, the incident metrics, the
 * stateless scorer, and the OpenAI-compatible facade over all three.
 *
 * They share one `InsightsService` instance, so the prose and the numbers in a
 * single response can never disagree — they are the same computation.
 */
@Module({
  imports: [AccessModule],
  controllers: [
    InsightsController,
    MetricsController,
    AnalyzeController,
    OpenAiController,
  ],
  providers: [
    InsightsService,
    OpenAiRenderer,
    MetricsService,
    ConversationsService,
  ],
})
export class IntelligenceModule {}
