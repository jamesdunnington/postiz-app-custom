import { Injectable } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { computeChainedSlots } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete-scheduling.logic';

// Fallbacks only — every Integration row carries its own pace via
// pinDeletePaceMin/MaxMinutes + pinDeletePaceBatchSize (defaulted to these
// same values in the schema), editable per account instead of blanket.
const PIN_DELETE_MIN_MINUTES = 50;
const PIN_DELETE_MAX_MINUTES = 60;
const PIN_DELETE_BATCH_SIZE = 1;

export interface PinterestDeleteQueueSummary {
  queued: number;
  queuedItems: {
    id: string;
    pinId: string;
    rawInput: string;
    scheduledFor: Date | null;
  }[];
  done: number;
  failed: {
    id: string;
    pinId: string;
    rawInput: string;
    errorMessage: string | null;
    processedAt: Date | null;
  }[];
  totalEverSubmitted: number;
  nextRunAt: Date | null;
  lastCompletionAt: Date | null;
}

@Injectable()
export class PinterestDeleteRepository {
  constructor(
    private _batch: PrismaRepository<'pinterestDeleteBatch'>,
    private _item: PrismaRepository<'pinterestDeleteItem'>,
    private _integration: PrismaRepository<'integration'>,
    private _transaction: PrismaTransaction
  ) {}

  // Computes each new item's slot by chaining off the integration's
  // pinDeleteNextSlot pointer, then creates the batch + items and advances
  // the pointer, all inside one transaction — so two submissions for the
  // same account never compute off the same stale pointer.
  createBatchWithItems(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL' | 'API' | 'MCP',
    parsedPins: { pinId: string; rawInput: string }[]
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      const integration = await tx.integration.findUniqueOrThrow({
        where: { id: integrationId },
        select: {
          pinDeleteNextSlot: true,
          pinDeletePaceMinMinutes: true,
          pinDeletePaceMaxMinutes: true,
          pinDeletePaceBatchSize: true,
        },
      });

      const slots = computeChainedSlots(
        integration.pinDeleteNextSlot,
        parsedPins.length,
        integration.pinDeletePaceMinMinutes ?? PIN_DELETE_MIN_MINUTES,
        integration.pinDeletePaceMaxMinutes ?? PIN_DELETE_MAX_MINUTES,
        new Date(),
        Math.random,
        integration.pinDeletePaceBatchSize ?? PIN_DELETE_BATCH_SIZE
      );

      const batch = await tx.pinterestDeleteBatch.create({
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
              status: 'PENDING',
              scheduledFor: slots[i],
            })),
          },
        },
        include: { items: true },
      });

      await tx.integration.update({
        where: { id: integrationId },
        data: { pinDeleteNextSlot: slots[slots.length - 1] },
      });

      return batch;
    });
  }

  getItemById(itemId: string) {
    return this._item.model.pinterestDeleteItem.findUnique({
      where: { id: itemId },
      include: { integration: true },
    });
  }

  markItemRemoved(itemId: string) {
    return this._item.model.pinterestDeleteItem.update({
      where: { id: itemId },
      data: { status: 'REMOVED', processedAt: new Date() },
    });
  }

  markItemFailed(itemId: string, errorMessage: string) {
    return this._item.model.pinterestDeleteItem.update({
      where: { id: itemId },
      data: { status: 'FAILED', errorMessage, processedAt: new Date() },
    });
  }

  // Rows still carrying a pre-cutover status value ("QUEUED" or
  // "WAITING_FOR_QUOTA" from the old quota model, since retired) — never
  // matched by any query in the new model, so they'd otherwise sit
  // forgotten in the table forever after this deploy.
  findLegacyStatusItems() {
    return this._item.model.pinterestDeleteItem.findMany({
      where: { status: { notIn: ['PENDING', 'REMOVED', 'FAILED'] } },
    });
  }

  // Folds pre-cutover items into the new chain as if they were just
  // submitted (in their original createdAt order), so nothing queued
  // before this deploy is silently lost.
  rescheduleItems(integrationId: string, itemIdsOldestFirst: string[]) {
    return this._transaction.model.$transaction(async (tx) => {
      const integration = await tx.integration.findUniqueOrThrow({
        where: { id: integrationId },
        select: {
          pinDeleteNextSlot: true,
          pinDeletePaceMinMinutes: true,
          pinDeletePaceMaxMinutes: true,
          pinDeletePaceBatchSize: true,
        },
      });

      const slots = computeChainedSlots(
        integration.pinDeleteNextSlot,
        itemIdsOldestFirst.length,
        integration.pinDeletePaceMinMinutes ?? PIN_DELETE_MIN_MINUTES,
        integration.pinDeletePaceMaxMinutes ?? PIN_DELETE_MAX_MINUTES,
        new Date(),
        Math.random,
        integration.pinDeletePaceBatchSize ?? PIN_DELETE_BATCH_SIZE
      );

      const updated = [];
      for (let i = 0; i < itemIdsOldestFirst.length; i++) {
        updated.push(
          await tx.pinterestDeleteItem.update({
            where: { id: itemIdsOldestFirst[i] },
            data: { status: 'PENDING', scheduledFor: slots[i] },
          })
        );
      }

      await tx.integration.update({
        where: { id: integrationId },
        data: { pinDeleteNextSlot: slots[slots.length - 1] },
      });

      return updated;
    });
  }

  findOverdueItems(staleBefore: Date) {
    return this._item.model.pinterestDeleteItem.findMany({
      where: { status: 'PENDING', scheduledFor: { lt: staleBefore } },
    });
  }

  async getQueueSummary(
    integrationId: string
  ): Promise<PinterestDeleteQueueSummary> {
    const items = await this._item.model.pinterestDeleteItem.findMany({
      where: { integrationId },
      select: {
        id: true,
        pinId: true,
        rawInput: true,
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
      queuedItems: pendingSorted.map(({ id, pinId, rawInput, scheduledFor }) => ({
        id,
        pinId,
        rawInput,
        scheduledFor,
      })),
      done: items.filter((i) => i.status === 'REMOVED').length,
      failed: items
        .filter((i) => i.status === 'FAILED')
        .map(({ id, pinId, rawInput, errorMessage, processedAt }) => ({
          id,
          pinId,
          rawInput,
          errorMessage,
          processedAt,
        })),
      totalEverSubmitted: items.length,
      nextRunAt: pendingSorted[0]?.scheduledFor ?? null,
      lastCompletionAt:
        pendingSorted[pendingSorted.length - 1]?.scheduledFor ?? null,
    };
  }

  // Only PENDING items belonging to this integration are eligible — already
  // REMOVED/FAILED ids passed in are silently ignored rather than erroring,
  // since the caller's selection may be stale by the time this runs (e.g.
  // the queue drained one more pin in the background). Returns the ids that
  // were actually deleted, so the caller can also drop their BullMQ delayed
  // jobs (deleting the row makes the queued item disappear from the count
  // even if that job still exists and fires — the worker already treats a
  // missing item as a clean no-op).
  async cancelItems(integrationId: string, itemIds: string[]): Promise<string[]> {
    if (itemIds.length === 0) return [];

    const matching = await this._item.model.pinterestDeleteItem.findMany({
      where: { integrationId, id: { in: itemIds }, status: 'PENDING' },
      select: { id: true },
    });
    if (matching.length === 0) return [];

    await this._item.model.pinterestDeleteItem.deleteMany({
      where: { id: { in: matching.map((i) => i.id) } },
    });

    return matching.map((i) => i.id);
  }

  // Deletes REMOVED/FAILED items older than `cutoff`, then deletes any
  // batch left with zero remaining items (batches have no display value
  // once empty). PENDING items are never touched regardless of age.
  async purgeCompletedItemsOlderThan(cutoff: Date): Promise<number> {
    const result = await this._item.model.pinterestDeleteItem.deleteMany({
      where: {
        status: { in: ['REMOVED', 'FAILED'] },
        processedAt: { lt: cutoff },
      },
    });
    await this._batch.model.pinterestDeleteBatch.deleteMany({
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
        pinDeletePaceMinMinutes: true,
        pinDeletePaceMaxMinutes: true,
        pinDeletePaceBatchSize: true,
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
        pinDeletePaceMinMinutes: pace.minMinutes,
        pinDeletePaceMaxMinutes: pace.maxMinutes,
        pinDeletePaceBatchSize: pace.batchSize,
      },
    });
    if (count === 0) {
      throw new Error('Integration not found');
    }
  }
}
