import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { Integration } from '@prisma/client';
import { PinterestDeleteRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.repository';
import { parsePinInput } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.logic';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';

// Two rolling 24h windows' worth of pins under the old quota model — kept as
// the per-submission cap under the new timer model too, just as a sane
// upper bound on a single form submission (the queue itself has no total
// size limit; you can submit again to append more).
const MAX_PINS_PER_BATCH = 200;

// Sane guardrails so a per-integration override can't accidentally recreate
// the exact burst behavior this pacing exists to avoid.
const MIN_ALLOWED_MINUTES = 5;
const MAX_ALLOWED_MINUTES = 1440; // 24h
const MAX_ALLOWED_BATCH_SIZE = 10;

@Injectable()
export class PinterestDeleteService {
  constructor(
    private _repository: PinterestDeleteRepository,
    private _integrationService: IntegrationService,
    private _integrationManager: IntegrationManager,
    private _workerServiceProducer: BullMqClient
  ) {}

  async createBatch(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL' | 'API' | 'MCP',
    rawPinInputs: string[]
  ): Promise<{ batchId: string; submittedCount: number }> {
    if (rawPinInputs.length === 0 || rawPinInputs.length > MAX_PINS_PER_BATCH) {
      throw new Error(
        `A batch must contain between 1 and ${MAX_PINS_PER_BATCH} pins`
      );
    }

    const integration = await this._integrationService.getIntegrationById(
      organizationId,
      integrationId
    );
    if (
      !integration ||
      integration.providerIdentifier !== 'pinterest' ||
      integration.deletedAt
    ) {
      throw new Error(
        'Integration not found, not a Pinterest account, or no longer connected'
      );
    }

    const parsedPins = rawPinInputs.map((rawInput) => ({
      rawInput,
      pinId: parsePinInput(rawInput),
    }));

    const invalid = parsedPins.filter((p) => !p.pinId);
    if (invalid.length > 0) {
      throw new Error(
        `Could not recognize ${invalid.length} pin id(s)/url(s): ${invalid
          .map((p) => p.rawInput)
          .join(', ')}`
      );
    }

    const batch = await this._repository.createBatchWithItems(
      organizationId,
      integrationId,
      createdByUserId,
      source,
      parsedPins as { pinId: string; rawInput: string }[]
    );

    for (const item of batch.items) {
      this._workerServiceProducer.emit('pinterest-delete-pin', {
        id: item.id,
        options: { delay: Math.max(0, item.scheduledFor!.getTime() - Date.now()) },
        payload: { itemId: item.id },
      });
    }

    return { batchId: batch.id, submittedCount: batch.items.length };
  }

  async processItem(itemId: string): Promise<void> {
    const item = await this._repository.getItemById(itemId);
    if (!item) {
      // Purged by the retention cron before this job ran. Clean no-op.
      return;
    }

    try {
      const accessToken = await this.getValidAccessToken(item.integration);
      const provider =
        this._integrationManager.getSocialIntegration('pinterest');
      const result = await provider.deletePin?.(
        item.integration.internalId,
        accessToken,
        item.pinId
      );

      if (!result?.success) {
        await this._repository.markItemFailed(
          itemId,
          'Pinterest reported the deletion failed'
        );
        return;
      }

      await this._repository.markItemRemoved(itemId);
    } catch (err) {
      await this._repository.markItemFailed(
        itemId,
        err instanceof Error ? err.message : 'Unknown error'
      );
      Sentry.captureException(err, {
        extra: { context: 'PinterestDeleteService.processItem', itemId },
      });
    }
  }

  // Mirrors the refresh-token orchestration already used for publishing
  // (see PostsService.postSocial in posts.service.ts) rather than extracting
  // a shared helper — kept local and duplicated deliberately, to avoid an
  // unrelated refactor of that already-working, unrelated code path.
  private async getValidAccessToken(
    integration: Integration
  ): Promise<string> {
    const provider =
      this._integrationManager.getSocialIntegration('pinterest');

    if (dayjs(integration.tokenExpiration).isAfter(dayjs())) {
      return integration.token;
    }

    const { accessToken, expiresIn, refreshToken, additionalSettings } =
      await provider.refreshToken(integration.refreshToken!);

    if (!accessToken) {
      await this._integrationService.refreshNeeded(
        integration.organizationId,
        integration.id
      );
      throw new Error('Pinterest token refresh failed');
    }

    await this._integrationService.createOrUpdateIntegration(
      additionalSettings,
      !!provider.oneTimeToken,
      integration.organizationId,
      integration.name,
      integration.picture!,
      'social',
      integration.internalId,
      integration.providerIdentifier,
      accessToken,
      refreshToken,
      expiresIn
    );

    return accessToken;
  }

  async findStalledItemIntegrationIds(staleMinutes = 15): Promise<string[]> {
    const staleBefore = dayjs().subtract(staleMinutes, 'minute').toDate();
    const stalled = await this._repository.findOverdueItems(staleBefore);
    return Array.from(new Set(stalled.map((i) => i.integrationId)));
  }

  // Self-healing recovery: an item's "trigger" is a BullMQ delayed job, not
  // the DB row itself, so if that job is ever lost (Redis restarted without
  // persistence, queue flushed, an app deploy landing mid-flight) the row
  // would otherwise sit PENDING forever with nothing to wake it up. Any item
  // still PENDING well past its scheduledFor time gets a fresh, immediate
  // job re-emitted — the DB row (with its scheduledFor) is the source of
  // truth, the BullMQ job is just disposable delivery for it.
  async recoverOverdueItems(staleMinutes = 15): Promise<number> {
    const staleBefore = dayjs().subtract(staleMinutes, 'minute').toDate();
    const overdue = await this._repository.findOverdueItems(staleBefore);

    for (const item of overdue) {
      try {
        await this._workerServiceProducer.delete('pinterest-delete-pin', item.id);
      } catch (err) {
        // No existing job to remove (already consumed or never created) —
        // that's exactly the case this recovery exists for.
      }
      this._workerServiceProducer.emit('pinterest-delete-pin', {
        id: item.id,
        options: { delay: 0 },
        payload: { itemId: item.id },
      });
    }

    return overdue.length;
  }

  listQueueSummary(integrationId: string) {
    return this._repository.getQueueSummary(integrationId);
  }

  getPacingSettings(organizationId: string, integrationId: string) {
    return this._repository.getPacingSettings(organizationId, integrationId);
  }

  // Only affects slots computed for pins submitted after this call — the
  // repository chains new slots off pinDeleteNextSlot without touching any
  // item that already has a scheduledFor, so already-queued pins keep
  // running on the pace they were submitted under.
  async updatePacingSettings(
    organizationId: string,
    integrationId: string,
    pace: { minMinutes: number; maxMinutes: number; batchSize: number }
  ) {
    if (
      pace.minMinutes < MIN_ALLOWED_MINUTES ||
      pace.maxMinutes > MAX_ALLOWED_MINUTES ||
      pace.minMinutes > pace.maxMinutes
    ) {
      throw new Error(
        `Interval must be between ${MIN_ALLOWED_MINUTES} and ${MAX_ALLOWED_MINUTES} minutes, with min <= max`
      );
    }
    if (pace.batchSize < 1 || pace.batchSize > MAX_ALLOWED_BATCH_SIZE) {
      throw new Error(
        `Pins per interval must be between 1 and ${MAX_ALLOWED_BATCH_SIZE}`
      );
    }

    await this._repository.updatePacingSettings(
      organizationId,
      integrationId,
      pace
    );
    return this.getPacingSettings(organizationId, integrationId);
  }

  // Cancels queued (PENDING) items by id, removing them from the DB and
  // dropping their BullMQ delayed jobs so nothing fires for them later.
  async cancelItems(
    organizationId: string,
    integrationId: string,
    itemIds: string[]
  ): Promise<{ cancelledIds: string[] }> {
    const integration = await this._integrationService.getIntegrationById(
      organizationId,
      integrationId
    );
    if (!integration || integration.providerIdentifier !== 'pinterest') {
      throw new Error('Integration not found or not a Pinterest account');
    }

    const cancelledIds = await this._repository.cancelItems(
      integrationId,
      itemIds
    );

    for (const id of cancelledIds) {
      try {
        await this._workerServiceProducer.delete('pinterest-delete-pin', id);
      } catch (err) {
        // No matching delayed job (already fired, or never created) — the
        // DB row is already gone either way, so there's nothing left to do.
      }
    }

    return { cancelledIds };
  }

  // One-time (idempotent) cutover migration: folds any item still carrying
  // a pre-cutover status ("QUEUED"/"WAITING_FOR_QUOTA" from the old quota
  // model) into the new chain, in original submission order, and re-emits
  // its BullMQ job. Safe to call on every boot — once no legacy rows
  // remain, it's a no-op.
  async migrateLegacyItems(): Promise<number> {
    const legacyItems = await this._repository.findLegacyStatusItems();
    if (legacyItems.length === 0) {
      return 0;
    }

    const byIntegration = new Map<string, typeof legacyItems>();
    for (const item of legacyItems) {
      const list = byIntegration.get(item.integrationId) || [];
      list.push(item);
      byIntegration.set(item.integrationId, list);
    }

    let migrated = 0;
    for (const [integrationId, items] of byIntegration) {
      const itemIdsOldestFirst = items
        .slice()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((i) => i.id);

      const updated = await this._repository.rescheduleItems(
        integrationId,
        itemIdsOldestFirst
      );

      for (const item of updated) {
        this._workerServiceProducer.emit('pinterest-delete-pin', {
          id: item.id,
          options: {
            delay: Math.max(0, item.scheduledFor!.getTime() - Date.now()),
          },
          payload: { itemId: item.id },
        });
      }

      migrated += updated.length;
    }

    return migrated;
  }
}
