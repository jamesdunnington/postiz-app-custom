import { Injectable } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { computeChainedSlots } from '@gitroom/nestjs-libraries/database/prisma/pinterest-move/pinterest-move-scheduling.logic';

// Fallbacks only — every Integration row carries its own pace via
// pinMovePaceMin/MaxMinutes + pinMovePaceBatchSize (defaulted to these same
// values in the schema), editable per account instead of blanket.
const PIN_MOVE_MIN_MINUTES = 50;
const PIN_MOVE_MAX_MINUTES = 60;
const PIN_MOVE_BATCH_SIZE = 1;

export interface PinterestMoveQueueSummary {
  queued: number;
  queuedItems: {
    id: string;
    pinId: string;
    rawInput: string;
    targetBoardId: string;
    targetBoardName: string;
    scheduledFor: Date | null;
  }[];
  done: number;
  failed: {
    id: string;
    pinId: string;
    rawInput: string;
    targetBoardId: string;
    targetBoardName: string;
    errorMessage: string | null;
    processedAt: Date | null;
  }[];
  totalEverSubmitted: number;
  nextRunAt: Date | null;
  lastCompletionAt: Date | null;
}

@Injectable()
export class PinterestMoveRepository {
  constructor(
    private _batch: PrismaRepository<'pinterestMoveBatch'>,
    private _item: PrismaRepository<'pinterestMoveItem'>,
    private _integration: PrismaRepository<'integration'>,
    private _transaction: PrismaTransaction
  ) {}

  // Computes each new item's slot by chaining off the integration's
  // pinMoveNextSlot pointer, then creates the batch + items and advances
  // the pointer, all inside one transaction — so two submissions for the
  // same account never compute off the same stale pointer. Every item in
  // the batch shares the one target board chosen for this submission.
  createBatchWithItems(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL' | 'API' | 'MCP',
    targetBoardId: string,
    targetBoardName: string,
    parsedPins: { pinId: string; rawInput: string }[]
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      const integration = await tx.integration.findUniqueOrThrow({
        where: { id: integrationId },
        select: {
          pinMoveNextSlot: true,
          pinMovePaceMinMinutes: true,
          pinMovePaceMaxMinutes: true,
          pinMovePaceBatchSize: true,
        },
      });

      const slots = computeChainedSlots(
        integration.pinMoveNextSlot,
        parsedPins.length,
        integration.pinMovePaceMinMinutes ?? PIN_MOVE_MIN_MINUTES,
        integration.pinMovePaceMaxMinutes ?? PIN_MOVE_MAX_MINUTES,
        new Date(),
        Math.random,
        integration.pinMovePaceBatchSize ?? PIN_MOVE_BATCH_SIZE
      );

      const batch = await tx.pinterestMoveBatch.create({
        data: {
          organizationId,
          integrationId,
          createdByUserId,
          source,
          submittedCount: parsedPins.length,
          items: {
            create: parsedPins.map(({ pinId, rawInput }, i) => ({
              integrationId,
              pinId,
              rawInput,
              targetBoardId,
              targetBoardName,
              status: 'PENDING',
              scheduledFor: slots[i],
            })),
          },
        },
        include: { items: true },
      });

      await tx.integration.update({
        where: { id: integrationId },
        data: { pinMoveNextSlot: slots[slots.length - 1] },
      });

      return batch;
    });
  }

  getItemById(itemId: string) {
    return this._item.model.pinterestMoveItem.findUnique({
      where: { id: itemId },
      include: { integration: true },
    });
  }

  markItemMoved(itemId: string) {
    return this._item.model.pinterestMoveItem.update({
      where: { id: itemId },
      data: { status: 'MOVED', processedAt: new Date() },
    });
  }

  markItemFailed(itemId: string, errorMessage: string) {
    return this._item.model.pinterestMoveItem.update({
      where: { id: itemId },
      data: { status: 'FAILED', errorMessage, processedAt: new Date() },
    });
  }

  findOverdueItems(staleBefore: Date) {
    return this._item.model.pinterestMoveItem.findMany({
      where: { status: 'PENDING', scheduledFor: { lt: staleBefore } },
    });
  }

  async getQueueSummary(
    integrationId: string
  ): Promise<PinterestMoveQueueSummary> {
    const items = await this._item.model.pinterestMoveItem.findMany({
      where: { integrationId },
      select: {
        id: true,
        pinId: true,
        rawInput: true,
        targetBoardId: true,
        targetBoardName: true,
        status: true,
        scheduledFor: true,
        errorMessage: true,
        processedAt: true,
      },
    });

    const pending = items.filter((i) => i.status === 'PENDING');
    const pendingSorted = [...pending].sort(
      (a, b) =>
        (a.scheduledFor?.getTime() ?? 0) - (b.scheduledFor?.getTime() ?? 0)
    );

    return {
      queued: pending.length,
      queuedItems: pendingSorted.map(
        ({ id, pinId, rawInput, targetBoardId, targetBoardName, scheduledFor }) => ({
          id,
          pinId,
          rawInput,
          targetBoardId,
          targetBoardName,
          scheduledFor,
        })
      ),
      done: items.filter((i) => i.status === 'MOVED').length,
      failed: items
        .filter((i) => i.status === 'FAILED')
        .map(
          ({ id, pinId, rawInput, targetBoardId, targetBoardName, errorMessage, processedAt }) => ({
            id,
            pinId,
            rawInput,
            targetBoardId,
            targetBoardName,
            errorMessage,
            processedAt,
          })
        ),
      totalEverSubmitted: items.length,
      nextRunAt: pendingSorted[0]?.scheduledFor ?? null,
      lastCompletionAt:
        pendingSorted[pendingSorted.length - 1]?.scheduledFor ?? null,
    };
  }

  // Only PENDING items belonging to this integration are eligible — already
  // MOVED/FAILED ids passed in are silently ignored rather than erroring,
  // since the caller's selection may be stale by the time this runs (e.g.
  // the queue drained one more pin in the background). Returns the ids that
  // were actually deleted, so the caller can also drop their BullMQ delayed
  // jobs (deleting the row makes the queued item disappear from the count
  // even if that job still exists and fires — the worker already treats a
  // missing item as a clean no-op).
  async cancelItems(integrationId: string, itemIds: string[]): Promise<string[]> {
    if (itemIds.length === 0) return [];

    const matching = await this._item.model.pinterestMoveItem.findMany({
      where: { integrationId, id: { in: itemIds }, status: 'PENDING' },
      select: { id: true },
    });
    if (matching.length === 0) return [];

    await this._item.model.pinterestMoveItem.deleteMany({
      where: { id: { in: matching.map((i) => i.id) } },
    });

    return matching.map((i) => i.id);
  }

  // Deletes MOVED/FAILED items older than `cutoff`, then deletes any batch
  // left with zero remaining items (batches have no display value once
  // empty). PENDING items are never touched regardless of age.
  async purgeCompletedItemsOlderThan(cutoff: Date): Promise<number> {
    const result = await this._item.model.pinterestMoveItem.deleteMany({
      where: {
        status: { in: ['MOVED', 'FAILED'] },
        processedAt: { lt: cutoff },
      },
    });
    await this._batch.model.pinterestMoveBatch.deleteMany({
      where: { items: { none: {} } },
    });
    return result.count;
  }

  // Scoped to the org so one org can't read/change another's pacing via a
  // guessed integration id.
  getPacingSettings(organizationId: string, integrationId: string) {
    return this._integration.model.integration.findFirstOrThrow({
      where: { id: integrationId, organizationId },
      select: {
        pinMovePaceMinMinutes: true,
        pinMovePaceMaxMinutes: true,
        pinMovePaceBatchSize: true,
      },
    });
  }

  // Only changes the pointer used for slots computed from here on —
  // already-scheduled PENDING items keep whatever scheduledFor they were
  // given at submission time, deliberately untouched.
  async updatePacingSettings(
    organizationId: string,
    integrationId: string,
    pace: { minMinutes: number; maxMinutes: number; batchSize: number }
  ) {
    const { count } = await this._integration.model.integration.updateMany({
      where: { id: integrationId, organizationId },
      data: {
        pinMovePaceMinMinutes: pace.minMinutes,
        pinMovePaceMaxMinutes: pace.maxMinutes,
        pinMovePaceBatchSize: pace.batchSize,
      },
    });
    if (count === 0) {
      throw new Error('Integration not found');
    }
  }
}
