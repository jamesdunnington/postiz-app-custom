import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { Integration } from '@prisma/client';
import { PinterestMoveRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-move/pinterest-move.repository';
import { parsePinInput } from '@gitroom/nestjs-libraries/database/prisma/pinterest-move/pinterest-move.logic';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';
import { BadBody, RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';

// Sane upper bound on a single form submission (the queue itself has no
// total size limit; you can submit again to append more to the same
// account's ongoing queue).
const MAX_PINS_PER_BATCH = 200;

// Sane guardrails so a per-integration override can't accidentally recreate
// the exact burst behavior this pacing exists to avoid.
const MIN_ALLOWED_MINUTES = 5;
const MAX_ALLOWED_MINUTES = 1440; // 24h
const MAX_ALLOWED_BATCH_SIZE = 10;

@Injectable()
export class PinterestMoveService {
  constructor(
    private _repository: PinterestMoveRepository,
    private _integrationService: IntegrationService,
    private _integrationManager: IntegrationManager,
    private _workerServiceProducer: BullMqClient
  ) {}

  async createBatch(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL' | 'API' | 'MCP',
    targetBoardId: string,
    targetBoardName: string | undefined,
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

    // The frontend (MANUAL) already has the board list loaded and always
    // supplies the name directly. The public API and MCP paths may only
    // have the id, so resolve the name by listing boards — but a lookup
    // miss is never fatal here, the id alone is enough to perform the move.
    let resolvedBoardName = targetBoardName;
    if (!resolvedBoardName) {
      try {
        const accessToken = await this.getValidAccessToken(integration);
        const provider =
          this._integrationManager.getSocialIntegration('pinterest');
        const boardsList = (await provider.boards?.(accessToken)) || [];
        const match = boardsList.find((b: any) => b.id === targetBoardId);
        resolvedBoardName = match?.name || targetBoardId;
      } catch (err) {
        resolvedBoardName = targetBoardId;
      }
    }

    const batch = await this._repository.createBatchWithItems(
      organizationId,
      integrationId,
      createdByUserId,
      source,
      targetBoardId,
      resolvedBoardName,
      parsedPins as { pinId: string; rawInput: string }[]
    );

    for (const item of batch.items) {
      this._workerServiceProducer.emit('pinterest-move-pin', {
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
      const result = await provider.movePin?.(
        item.integration.internalId,
        accessToken,
        item.pinId,
        item.targetBoardId
      );

      if (!result?.success) {
        await this._repository.markItemFailed(
          itemId,
          'Pinterest reported the move failed'
        );
        return;
      }

      await this._repository.markItemMoved(itemId);
    } catch (err) {
      // this.fetch (in SocialAbstract) throws a plain BadBody object — not
      // an Error subclass — on most non-2xx responses, and a separate plain
      // RefreshToken object specifically for 401s, carrying Pinterest's raw
      // response body in `.json` either way. Without checking both, that
      // body is silently discarded and every failure (wrong board, rate
      // limit, a restricted-feature rejection, anything) shows up as the
      // same unhelpful "Unknown error", which defeats the point of a
      // Failed-pins list.
      const errorMessage =
        err instanceof BadBody || err instanceof RefreshToken
          ? err.json || err.message || 'Unknown error'
          : err instanceof Error
          ? err.message
          : 'Unknown error';
      await this._repository.markItemFailed(itemId, errorMessage);
      Sentry.captureException(err, {
        extra: { context: 'PinterestMoveService.processItem', itemId },
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
        await this._workerServiceProducer.delete('pinterest-move-pin', item.id);
      } catch (err) {
        // No existing job to remove (already consumed or never created) —
        // that's exactly the case this recovery exists for.
      }
      this._workerServiceProducer.emit('pinterest-move-pin', {
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
  // repository chains new slots off pinMoveNextSlot without touching any
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
        await this._workerServiceProducer.delete('pinterest-move-pin', id);
      } catch (err) {
        // No matching delayed job (already fired, or never created) — the
        // DB row is already gone either way, so there's nothing left to do.
      }
    }

    return { cancelledIds };
  }
}
