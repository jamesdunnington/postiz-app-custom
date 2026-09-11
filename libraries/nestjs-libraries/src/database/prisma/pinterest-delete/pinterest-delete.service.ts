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

  listQueueSummary(integrationId: string) {
    return this._repository.getQueueSummary(integrationId);
  }
}
