import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

const DAILY_CAP = 100;
const WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PinterestDeleteRepository {
  constructor(
    private _batch: PrismaRepository<'pinterestDeleteBatch'>,
    private _item: PrismaRepository<'pinterestDeleteItem'>,
    private _integration: PrismaRepository<'integration'>
  ) {}

  createBatchWithItems(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL' | 'API' | 'MCP',
    parsedPins: { pinId: string; rawInput: string }[]
  ) {
    return this._batch.model.pinterestDeleteBatch.create({
      data: {
        organizationId,
        integrationId,
        createdByUserId,
        source,
        submittedCount: parsedPins.length,
        items: {
          create: parsedPins.map(({ pinId, rawInput }) => ({
            integrationId,
            pinId,
            rawInput,
            status: 'PENDING',
          })),
        },
      },
      include: { items: true },
    });
  }

  async listBatchIdsForIntegrationNewestFirst(
    integrationId: string
  ): Promise<string[]> {
    const rows = await this._batch.model.pinterestDeleteBatch.findMany({
      where: { integrationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  deleteBatchesByIds(batchIds: string[]) {
    if (batchIds.length === 0) {
      return Promise.resolve();
    }
    return this._batch.model.pinterestDeleteBatch.deleteMany({
      where: { id: { in: batchIds } },
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

  markItemWaitingForQuota(itemId: string, scheduledFor: Date) {
    return this._item.model.pinterestDeleteItem.update({
      where: { id: itemId },
      data: { status: 'WAITING_FOR_QUOTA', scheduledFor },
    });
  }

  markItemPending(itemId: string) {
    return this._item.model.pinterestDeleteItem.update({
      where: { id: itemId },
      data: { status: 'PENDING', scheduledFor: null },
    });
  }

  findDueWaitingItems(now: Date) {
    return this._item.model.pinterestDeleteItem.findMany({
      where: { status: 'WAITING_FOR_QUOTA', scheduledFor: { lte: now } },
    });
  }

  findStalledIntegrationItems(staleBefore: Date) {
    return this._item.model.pinterestDeleteItem.findMany({
      where: {
        status: { in: ['PENDING', 'QUEUED'] },
        updatedAt: { lt: staleBefore },
      },
    });
  }

  listBatchSummariesForIntegration(integrationId: string) {
    return this._batch.model.pinterestDeleteBatch.findMany({
      where: { integrationId },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });
  }

  // Atomically reserves one deletion slot for this integration's rolling
  // 24h window, or reports when the caller should retry. Implemented as two
  // single-statement conditional UPDATEs (not a read-then-write) so it stays
  // correct under concurrent job handlers for the same integration — a bare
  // SELECT-then-UPDATE would race under BullMQ's worker concurrency.
  async reserveQuotaSlot(
    integrationId: string
  ): Promise<{ allowed: true } | { allowed: false; scheduledFor: Date }> {
    const now = new Date();
    const windowCutoff = new Date(now.getTime() - WINDOW_MS);

    const underCap = await this._integration.model.integration.updateMany({
      where: {
        id: integrationId,
        pinDeleteWindowCount: { lt: DAILY_CAP },
        pinDeleteLastAt: { gte: windowCutoff },
      },
      data: { pinDeleteWindowCount: { increment: 1 }, pinDeleteLastAt: now },
    });

    if (underCap.count > 0) {
      return { allowed: true };
    }

    const windowExpired =
      await this._integration.model.integration.updateMany({
        where: {
          id: integrationId,
          OR: [
            { pinDeleteLastAt: null },
            { pinDeleteLastAt: { lt: windowCutoff } },
          ],
        },
        data: { pinDeleteWindowCount: 1, pinDeleteLastAt: now },
      });

    if (windowExpired.count > 0) {
      return { allowed: true };
    }

    const integration =
      await this._integration.model.integration.findUniqueOrThrow({
        where: { id: integrationId },
        select: { pinDeleteLastAt: true },
      });

    return {
      allowed: false,
      scheduledFor: new Date(
        integration.pinDeleteLastAt!.getTime() + WINDOW_MS
      ),
    };
  }

  // Reverses a reservation made by reserveQuotaSlot when the delete call
  // itself failed (a failure must not permanently cost a daily-cap slot).
  releaseQuotaSlot(integrationId: string) {
    return this._integration.model.integration.update({
      where: { id: integrationId },
      data: { pinDeleteWindowCount: { decrement: 1 } },
    });
  }
}
