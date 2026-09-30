import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { InsightsService } from '../engine/insights.service';
import type { Principal } from '../auth/principal';

/**
 * The structured REST surface. Prefer this over the chat shape when building a
 * UI: these are the raw numbers, not prose about them.
 */
@Controller('insights')
@UseGuards(ApiKeyGuard)
export class InsightsController {
  constructor(private readonly engine: InsightsService) {}

  /** Health score, KPIs and rule-based insights. */
  @Get('overview')
  overview(@CurrentPrincipal() principal: Principal) {
    return this.engine.getOverview(principal.organizationId);
  }

  /** Sites ranked by risk over the last 30 days, most exposed first. */
  @Get('risk-by-site')
  riskBySite(@CurrentPrincipal() principal: Principal) {
    return this.engine.getRiskBySite(principal.organizationId);
  }

  /** Personnel flagged at risk over the last 14 days. */
  @Get('at-risk-guards')
  atRiskGuards(@CurrentPrincipal() principal: Principal) {
    return this.engine.getAtRiskGuards(principal.organizationId);
  }
}
