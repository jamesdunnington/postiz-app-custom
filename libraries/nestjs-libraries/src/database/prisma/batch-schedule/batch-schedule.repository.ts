import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AssignedRow } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.logic';

export interface BatchScheduleQueueSummary {
  queued: number;
  done: number;
  failed: {
    id: string;
    content: string;
    boardId: string;
    errorMessage: string | null;
  }[];
  submittedCount: number;
  items: {
    id: string;
    content: string;
    boardId: string;
    status: string;
    assignedPublishDate: Date;
    postizPostId: string | null;
    errorMessage: string | null;
  }[];
}

@Injectable()
export class BatchScheduleRepository {
  constructor(
    private _batch: PrismaRepository<'batchScheduleBatch'>,
    private _item: PrismaRepository<'batchScheduleItem'>
  ) {}

  async createBatchWithItems(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL',
    rows: AssignedRow[]
  ) {
    return this._batch.model.batchScheduleBatch.create({
      data: {
        organizationId,
        integrationId,
        createdByUserId,
        source,
        submittedCount: rows.length,
        items: {
          create: rows.map((row) => ({
            integrationId,
            content: row.content,
            title: row.title,
            imageUrl: row.imageUrl,
            boardId: row.boardId,
            altText: row.altText,
            link: row.link,
            assignedPublishDate: row.assignedPublishDate,
            status: 'PENDING',
          })),
        },
      },
      include: { items: true },
    });
  }

  getItemById(itemId: string) {
    return this._item.model.batchScheduleItem.findUnique({
      where: { id: itemId },
      include: { integration: true },
    });
  }

  markItemScheduled(itemId: string, postizPostId: string) {
    return this._item.model.batchScheduleItem.update({
      where: { id: itemId },
      data: { status: 'SCHEDULED', postizPostId, processedAt: new Date() },
    });
  }

  markItemFailed(itemId: string, errorMessage: string) {
    return this._item.model.batchScheduleItem.update({
      where: { id: itemId },
      data: { status: 'FAILED', errorMessage, processedAt: new Date() },
    });
  }

  resetItemToPending(itemId: string) {
    return this._item.model.batchScheduleItem.update({
      where: { id: itemId },
      data: {
        status: 'PENDING',
        errorMessage: null,
        processedAt: null,
      },
    });
  }

  findOverdueItems(staleBefore: Date) {
    return this._item.model.batchScheduleItem.findMany({
      where: { status: 'PENDING', createdAt: { lt: staleBefore } },
    });
  }

  async getQueueSummary(
    integrationId: string
  ): Promise<BatchScheduleQueueSummary> {
    // Only the most recently submitted batch is shown: a new upload
    // replaces the previous one's displayed status/errors rather than
    // accumulating history across every batch ever submitted.
    const latestBatch = await this._batch.model.batchScheduleBatch.findFirst({
      where: { integrationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    const items = latestBatch
      ? await this._item.model.batchScheduleItem.findMany({
          where: { batchId: latestBatch.id },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            content: true,
            boardId: true,
            status: true,
            assignedPublishDate: true,
            postizPostId: true,
            errorMessage: true,
          },
        })
      : [];

    return {
      queued: items.filter((i) => i.status === 'PENDING').length,
      done: items.filter((i) => i.status === 'SCHEDULED').length,
      failed: items
        .filter((i) => i.status === 'FAILED')
        .map(({ id, content, boardId, errorMessage }) => ({
          id,
          content,
          boardId,
          errorMessage,
        })),
      submittedCount: items.length,
      items,
    };
  }

  async purgeCompletedItemsOlderThan(cutoff: Date): Promise<number> {
    const result = await this._item.model.batchScheduleItem.deleteMany({
      where: {
        status: { in: ['SCHEDULED', 'FAILED'] },
        processedAt: { lt: cutoff },
      },
    });
    await this._batch.model.batchScheduleBatch.deleteMany({
      where: { items: { none: {} } },
    });
    return result.count;
  }
}
