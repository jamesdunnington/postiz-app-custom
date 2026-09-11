import { Injectable } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { computeChainedSlots } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete-scheduling.logic';

const PIN_DELETE_MIN_MINUTES = 50;
const PIN_DELETE_MAX_MINUTES = 60;

export interface PinterestDeleteQueueSummary {
  queued: number;
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
        select: { pinDeleteNextSlot: true },
      });

      const slots = computeChainedSlots(
        integration.pinDeleteNextSlot,
        parsedPins.length,
        PIN_DELETE_MIN_MINUTES,
        PIN_DELETE_MAX_MINUTES
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
}
