import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { Integration } from '@prisma/client';
import { PinterestBoardDeleteRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.repository';
import { excludeAlreadyPendingBoards } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.repository';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';

const MAX_BOARDS_PER_BATCH = 25;

@Injectable()
export class PinterestBoardDeleteService {
  constructor(
    private _repository: PinterestBoardDeleteRepository,
    private _integrationService: IntegrationService,
    private _integrationManager: IntegrationManager,
    private _workerServiceProducer: BullMqClient
  ) {}

  async createBatch(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    boards: { boardId: string; boardName: string }[]
  ): Promise<{ batchId: string; submittedCount: number }> {
    if (boards.length === 0 || boards.length > MAX_BOARDS_PER_BATCH) {
      throw new Error(
        `A batch must contain between 1 and ${MAX_BOARDS_PER_BATCH} boards`
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

    const alreadyPendingBoardIds = await this._repository.findPendingBoardIds(
      integrationId
    );
    const toQueue = excludeAlreadyPendingBoards(boards, alreadyPendingBoardIds);

    if (toQueue.length === 0) {
      throw new Error('All selected boards are already queued for deletion');
    }

    const batch = await this._repository.createBatchWithItems(
      organizationId,
      integrationId,
      createdByUserId,
      'MANUAL',
      toQueue
    );

    for (const item of batch.items) {
      this._workerServiceProducer.emit('pinterest-delete-board', {
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
      return;
    }

    try {
      const accessToken = await this.getValidAccessToken(item.integration);
      const provider =
        this._integrationManager.getSocialIntegration('pinterest');
      const result = await provider.deleteBoard?.(
        item.integration.internalId,
        accessToken,
        item.boardId
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
        extra: { context: 'PinterestBoardDeleteService.processItem', itemId },
      });
    }
  }

  // Mirrors PinterestDeleteService.getValidAccessToken — kept local and
  // duplicated deliberately rather than extracting a shared helper, to
  // avoid an unrelated refactor of that already-working, unrelated code path.
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

  // Mirrors PinterestDeleteService.recoverOverdueItems — see that comment
  // for why this exists: the DB row's scheduledFor is the source of truth,
  // the BullMQ job is disposable delivery that can be lost across a Redis
  // restart or an app deploy landing mid-flight.
  async recoverOverdueItems(staleMinutes = 15): Promise<number> {
    const staleBefore = dayjs().subtract(staleMinutes, 'minute').toDate();
    const overdue = await this._repository.findOverdueItems(staleBefore);

    for (const item of overdue) {
      try {
        await this._workerServiceProducer.delete('pinterest-delete-board', item.id);
      } catch (err) {
        // No existing job to remove — that's the case this exists for.
      }
      this._workerServiceProducer.emit('pinterest-delete-board', {
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

  // Mirrors PinterestDeleteService.cancelItems for the board-deletion queue.
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
        await this._workerServiceProducer.delete('pinterest-delete-board', id);
      } catch (err) {
        // No matching delayed job (already fired, or never created) — the
        // DB row is already gone either way, so there's nothing left to do.
      }
    }

    return { cancelledIds };
  }

  // Resolves board names to ids by listing the account's boards (including
  // archived ones) and matching case-insensitively — for callers, like the
  // MCP tool, that only have a human-readable name to go on rather than an
  // id looked up through the UI's board picker.
  async resolveBoardIdsByName(
    organizationId: string,
    integrationId: string,
    boardNames: string[]
  ): Promise<{
    matched: { boardId: string; boardName: string }[];
    notFound: string[];
  }> {
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

    const accessToken = await this.getValidAccessToken(integration);
    const provider = this._integrationManager.getSocialIntegration('pinterest');
    const allBoards = (await provider.boards?.(accessToken, { includeArchived: true })) || [];

    const matched: { boardId: string; boardName: string }[] = [];
    const notFound: string[] = [];
    for (const requestedName of boardNames) {
      const match = allBoards.find(
        (b) => b.name.toLowerCase() === requestedName.toLowerCase()
      );
      if (!match) {
        notFound.push(requestedName);
        continue;
      }
      matched.push({ boardId: match.id, boardName: match.name });
    }

    return { matched, notFound };
  }
}
