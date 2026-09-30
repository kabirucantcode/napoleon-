import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequireScope } from '../auth/require-scope.decorator';
import { IngestService, RISK_LEVELS, SEVERITIES } from './ingest.service';
import type { Principal } from '../auth/principal';

const MAX_BATCH = 5000;

function bad(message: string): BadRequestException {
  return new BadRequestException(message);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw bad(`\`${field}\` must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field);
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw bad(`\`${field}\` must be a finite number.`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredNumber(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw bad(`\`${field}\` must be a boolean.`);
  }
  return value;
}

function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    throw bad(`\`${field}\` must be an ISO 8601 date.`);
  }
  return date;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw bad(`\`${field}\` must be one of ${allowed.join(', ')}.`);
  }
  return value as T;
}

function optionalOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return oneOf(value, allowed, field);
}

function items(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw bad(`\`${field}\` must be an array.`);
  }
  if (value.length === 0) return [];
  if (value.length > MAX_BATCH) {
    throw bad(
      `\`${field}\` is limited to ${MAX_BATCH} records per request. Split larger runs.`,
    );
  }
  return value as Record<string, unknown>[];
}

/**
 * Ingestion endpoints. All ADMIN-scoped: a READ key must never be able to
 * rewrite the data its own analysis is drawn from.
 *
 * Bodies are validated by hand rather than with DTO classes, because the useful
 * errors here are per-record (`incidents[3].reportedAt`) and that is awkward to
 * express through the global pipe.
 */
@Controller('ingest')
@UseGuards(ApiKeyGuard)
@RequireScope('ADMIN')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post('sites')
  async sites(
    @CurrentPrincipal() principal: Principal,
    @Body() body: Record<string, unknown>,
  ) {
    const rows = items(body?.sites, 'sites').map((raw, i) => ({
      externalId: requiredString(raw.externalId, `sites[${i}].externalId`),
      name: requiredString(raw.name, `sites[${i}].name`),
      riskLevel: optionalOneOf(raw.riskLevel, RISK_LEVELS, `sites[${i}].riskLevel`),
    }));
    return this.ingest.upsertSites(principal.organizationId, rows);
  }

  @Post('guards')
  async guards(
    @CurrentPrincipal() principal: Principal,
    @Body() body: Record<string, unknown>,
  ) {
    const rows = items(body?.guards, 'guards').map((raw, i) => ({
      externalId: requiredString(raw.externalId, `guards[${i}].externalId`),
      fullName: requiredString(raw.fullName, `guards[${i}].fullName`),
      status: optionalString(raw.status, `guards[${i}].status`),
      performanceScore: optionalNumber(
        raw.performanceScore,
        `guards[${i}].performanceScore`,
      ),
      currentShift: optionalString(raw.currentShift, `guards[${i}].currentShift`),
      siteExternalId: optionalString(
        raw.siteExternalId,
        `guards[${i}].siteExternalId`,
      ),
    }));
    return this.ingest.upsertGuards(principal.organizationId, rows);
  }

  @Post('incidents')
  async incidents(
    @CurrentPrincipal() principal: Principal,
    @Body() body: Record<string, unknown>,
  ) {
    const rows = items(body?.incidents, 'incidents').map((raw, i) => {
      const reportedAt = optionalDate(
        raw.reportedAt,
        `incidents[${i}].reportedAt`,
      );
      if (!reportedAt) {
        throw bad(`\`incidents[${i}].reportedAt\` is required.`);
      }
      return {
        externalId: requiredString(raw.externalId, `incidents[${i}].externalId`),
        siteExternalId: requiredString(
          raw.siteExternalId,
          `incidents[${i}].siteExternalId`,
        ),
        severity: oneOf(raw.severity, SEVERITIES, `incidents[${i}].severity`),
        status: optionalString(raw.status, `incidents[${i}].status`),
        type: optionalString(raw.type, `incidents[${i}].type`) ?? null,
        reportedAt,
      };
    });
    return this.ingest.upsertIncidents(principal.organizationId, rows);
  }

  @Post('attendance')
  async attendance(
    @CurrentPrincipal() principal: Principal,
    @Body() body: Record<string, unknown>,
  ) {
    const rows = items(body?.attendance, 'attendance').map((raw, i) => ({
      externalId: requiredString(raw.externalId, `attendance[${i}].externalId`),
      guardExternalId: requiredString(
        raw.guardExternalId,
        `attendance[${i}].guardExternalId`,
      ),
      siteExternalId: requiredString(
        raw.siteExternalId,
        `attendance[${i}].siteExternalId`,
      ),
      createdAt: optionalDate(raw.createdAt, `attendance[${i}].createdAt`),
      isLate: optionalBoolean(raw.isLate, `attendance[${i}].isLate`),
      isAbsent: optionalBoolean(raw.isAbsent, `attendance[${i}].isAbsent`),
      status: optionalString(raw.status, `attendance[${i}].status`),
    }));
    return this.ingest.upsertAttendance(principal.organizationId, rows);
  }

  @Post('patrols')
  async patrols(
    @CurrentPrincipal() principal: Principal,
    @Body() body: Record<string, unknown>,
  ) {
    const routes = items(body?.routes, 'routes').map((raw, i) => ({
      externalId: requiredString(raw.externalId, `routes[${i}].externalId`),
      siteExternalId: requiredString(
        raw.siteExternalId,
        `routes[${i}].siteExternalId`,
      ),
      name: optionalString(raw.name, `routes[${i}].name`),
    }));
    const records = items(body?.records, 'records').map((raw, i) => ({
      externalId: requiredString(raw.externalId, `records[${i}].externalId`),
      guardExternalId: requiredString(
        raw.guardExternalId,
        `records[${i}].guardExternalId`,
      ),
      routeExternalId: requiredString(
        raw.routeExternalId,
        `records[${i}].routeExternalId`,
      ),
      completionPercentage: requiredNumber(
        raw.completionPercentage,
        `records[${i}].completionPercentage`,
      ),
      createdAt: optionalDate(raw.createdAt, `records[${i}].createdAt`),
    }));
    return this.ingest.upsertPatrols(principal.organizationId, routes, records);
  }

  /**
   * Erase every operational record. Deliberately requires an explicit
   * confirmation token, because this is the one irreversible endpoint and it
   * will be called while someone is mid-integration by accident.
   *
   * API keys and the organization survive, so a reset cannot lock you out.
   */
  @Delete('data')
  async erase(
    @CurrentPrincipal() principal: Principal,
    @Query('confirm') confirm?: string,
  ) {
    if (confirm !== 'erase-all') {
      throw bad(
        'Refusing to erase. Pass `?confirm=erase-all` to acknowledge that this deletes every site, guard, incident, attendance and patrol record for your organization.',
      );
    }
    return this.ingest.eraseOperationalData(principal.organizationId);
  }
}
