import { Injectable } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { computeChainedSlots } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete-scheduling.logic';

const BOARD_DELETE_MIN_MINUTES = 300;
const BOARD_DELETE_MAX_MINUTES = 320;

export interface PinterestBoardDeleteQueueSummary {
  queued: number;
  done: number;
  failed: {
    id: string;
    boardId: string;
    boardName: string;
    errorMessage: string | null;
    processedAt: Date | null;
  }[];
  totalEverSubmitted: number;
  nextRunAt: Date | null;
  lastCompletionAt: Date | null;
  items: {
    id: string;
    boardId: string;
    boardName: string;
    status: string;
    scheduledFor: Date | null;
    errorMessage: string | null;
  }[];
}

// Pure filter, extracted so it's testable without a database: drops any
// submitted board whose id is already PENDING in this integration's queue.
export function excludeAlreadyPendingBoards<
  T extends { boardId: string }
>(boards: T[], alreadyPendingBoardIds: string[]): T[] {
  const pendingSet = new Set(alreadyPendingBoardIds);
  return boards.filter((b) => !pendingSet.has(b.boardId));
}

@Injectable()
export class PinterestBoardDeleteRepository {
  constructor(
    private _batch: PrismaRepository<'pinterestBoardDeleteBatch'>,
    private _item: PrismaRepository<'pinterestBoardDeleteItem'>,
    private _transaction: PrismaTransaction
  ) {}

  createBatchWithItems(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL',
    boards: { boardId: string; boardName: string }[]
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      const integration = await tx.integration.findUniqueOrThrow({
        where: { id: integrationId },
        select: { boardDeleteNextSlot: true },
      });

      const slots = computeChainedSlots(
        integration.boardDeleteNextSlot,
        boards.length,
        BOARD_DELETE_MIN_MINUTES,
        BOARD_DELETE_MAX_MINUTES
      );

      const batch = await tx.pinterestBoardDeleteBatch.create({
        data: {
          organizationId,
          integrationId,
          createdByUserId,
          source,
          submittedCount: boards.length,
          items: {
            create: boards.map(({ boardId, boardName }, i) => ({
              integrationId,
              boardId,
              boardName,
              status: 'PENDING',
              scheduledFor: slots[i],
            })),
          },
        },
        include: { items: true },
      });

      await tx.integration.update({
        where: { id: integrationId },
        data: { boardDeleteNextSlot: slots[slots.length - 1] },
      });

      return batch;
    });
  }

  getItemById(itemId: string) {
    return this._item.model.pinterestBoardDeleteItem.findUnique({
      where: { id: itemId },
      include: { integration: true },
    });
  }

  markItemRemoved(itemId: string) {
    return this._item.model.pinterestBoardDeleteItem.update({
      where: { id: itemId },
      data: { status: 'REMOVED', processedAt: new Date() },
    });
  }

  markItemFailed(itemId: string, errorMessage: string) {
    return this._item.model.pinterestBoardDeleteItem.update({
      where: { id: itemId },
      data: { status: 'FAILED', errorMessage, processedAt: new Date() },
    });
  }

  async findPendingBoardIds(integrationId: string): Promise<string[]> {
    const rows = await this._item.model.pinterestBoardDeleteItem.findMany({
      where: { integrationId, status: 'PENDING' },
      select: { boardId: true },
    });
    return rows.map((r) => r.boardId);
  }

  findOverdueItems(staleBefore: Date) {
    return this._item.model.pinterestBoardDeleteItem.findMany({
      where: { status: 'PENDING', scheduledFor: { lt: staleBefore } },
    });
  }

  async getQueueSummary(
    integrationId: string
  ): Promise<PinterestBoardDeleteQueueSummary> {
    const items = await this._item.model.pinterestBoardDeleteItem.findMany({
      where: { integrationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        boardId: true,
        boardName: true,
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
        .map(({ id, boardId, boardName, errorMessage, processedAt }) => ({
          id,
          boardId,
          boardName,
          errorMessage,
          processedAt,
        })),
      totalEverSubmitted: items.length,
      nextRunAt: pendingSorted[0]?.scheduledFor ?? null,
      lastCompletionAt:
        pendingSorted[pendingSorted.length - 1]?.scheduledFor ?? null,
      items: items.map(
        ({ id, boardId, boardName, status, scheduledFor, errorMessage }) => ({
          id,
          boardId,
          boardName,
          status,
          scheduledFor,
          errorMessage,
        })
      ),
    };
  }

  // Mirrors PinterestDeleteRepository.cancelItems — only PENDING items
  // belonging to this integration are eligible; already REMOVED/FAILED ids
  // are silently ignored since the caller's selection may be stale.
  async cancelItems(integrationId: string, itemIds: string[]): Promise<string[]> {
    if (itemIds.length === 0) return [];

    const matching = await this._item.model.pinterestBoardDeleteItem.findMany({
      where: { integrationId, id: { in: itemIds }, status: 'PENDING' },
      select: { id: true },
    });
    if (matching.length === 0) return [];

    await this._item.model.pinterestBoardDeleteItem.deleteMany({
      where: { id: { in: matching.map((i) => i.id) } },
    });

    return matching.map((i) => i.id);
  }

  async purgeCompletedItemsOlderThan(cutoff: Date): Promise<number> {
    const result = await this._item.model.pinterestBoardDeleteItem.deleteMany({
      where: {
        status: { in: ['REMOVED', 'FAILED'] },
        processedAt: { lt: cutoff },
      },
    });
    await this._batch.model.pinterestBoardDeleteBatch.deleteMany({
      where: { items: { none: {} } },
    });
    return result.count;
  }
}
