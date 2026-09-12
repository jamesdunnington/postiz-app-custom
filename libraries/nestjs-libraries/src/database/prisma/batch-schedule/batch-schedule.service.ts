import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { BatchScheduleRepository } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.repository';
import {
  assignPublishDates,
  BatchScheduleRow,
  RowError,
} from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.logic';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';

const MAX_ROWS_PER_BATCH = 500;

// Items process one at a time (see PATTERN_CONCURRENCY in bull-mq-transport-new/strategy.ts),
// but 500 fully serial items would still hammer the image-rehost source back
// to back. Group submission into batches of 20 with a 2s gap between groups
// so a 120-row CSV lands as 6 groups instead of one 120-item burst.
const ENQUEUE_BATCH_SIZE = 20;
const ENQUEUE_BATCH_DELAY_MS = 2000;

@Injectable()
export class BatchScheduleService {
  private storage = UploadFactory.createStorage();

  constructor(
    private _repository: BatchScheduleRepository,
    private _integrationService: IntegrationService,
    private _integrationRepository: IntegrationRepository,
    private _postsRepository: PostsRepository,
    private _postsService: PostsService,
    private _mediaService: MediaService,
    private _integrationManager: IntegrationManager,
    private _workerServiceProducer: BullMqClient
  ) {}

  async createBatch(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    rows: BatchScheduleRow[]
  ): Promise<{ batchId: string; submittedCount: number; rejected: RowError[] }> {
    if (rows.length === 0 || rows.length > MAX_ROWS_PER_BATCH) {
      throw new Error(
        `A batch must contain between 1 and ${MAX_ROWS_PER_BATCH} rows`
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

    const integrationWithOrg =
      await this._integrationRepository.getIntegrationByIdOnly(integrationId);
    const userTimezone =
      integrationWithOrg?.organization?.users?.[0]?.user?.timezone || 0;
    const postingTimes = JSON.parse(integration.postingTimes || '[]');

    const { assigned, errors } = await assignPublishDates(
      rows,
      new Date(),
      (count) =>
        this._postsRepository.getNextAvailableSlots(
          organizationId,
          integrationId,
          count,
          postingTimes,
          true,
          userTimezone
        )
    );

    if (assigned.length === 0) {
      return { batchId: '', submittedCount: 0, rejected: errors };
    }

    const batch = await this._repository.createBatchWithItems(
      organizationId,
      integrationId,
      createdByUserId,
      'MANUAL',
      assigned
    );

    batch.items.forEach((item, index) => {
      const delay =
        Math.floor(index / ENQUEUE_BATCH_SIZE) * ENQUEUE_BATCH_DELAY_MS;
      this._workerServiceProducer.emit('batch-schedule-item', {
        id: item.id,
        options: { delay },
        payload: { itemId: item.id },
      });
    });

    return {
      batchId: batch.id,
      submittedCount: batch.items.length,
      rejected: errors,
    };
  }

  async processItem(itemId: string): Promise<void> {
    const item = await this._repository.getItemById(itemId);
    if (!item) {
      // Purged by the retention cron before this job ran. Clean no-op.
      return;
    }
    if (item.status !== 'PENDING') {
      // Already processed (or mid-retry) — avoid double-creating a post.
      return;
    }

    try {
      const rehostedPath = await this.storage.uploadSimple(item.imageUrl);
      const media = await this._mediaService.saveFile(
        item.integration.organizationId,
        rehostedPath.split('/').pop()!,
        rehostedPath
      );

      const result = await this._postsService.createPost(
        item.integration.organizationId,
        {
          type: 'schedule',
          shortLink: false,
          tags: [],
          date: item.assignedPublishDate.toISOString(),
          posts: [
            {
              integration: { id: item.integrationId },
              group: makeId(10),
              value: [
                {
                  id: makeId(10),
                  content: item.content,
                  image: [
                    {
                      id: media.id,
                      path: media.path,
                      ...(item.altText ? { alt: item.altText } : {}),
                    } as any,
                  ],
                },
              ],
              settings: {
                __type: 'pinterest',
                board: item.boardId,
                ...(item.title ? { title: item.title } : {}),
                ...(item.link ? { link: item.link } : {}),
              } as any,
            },
          ],
        } as any
      );

      const postizPostId = result?.[0]?.postId;
      if (!postizPostId) {
        await this._repository.markItemFailed(
          itemId,
          'Post creation did not return a post id'
        );
        return;
      }

      await this._repository.markItemScheduled(itemId, postizPostId);
    } catch (err) {
      await this._repository.markItemFailed(
        itemId,
        err instanceof Error ? err.message : 'Unknown error'
      );
      Sentry.captureException(err, {
        extra: { context: 'BatchScheduleService.processItem', itemId },
      });
    }
  }

  async retryItem(itemId: string): Promise<void> {
    const item = await this._repository.getItemById(itemId);
    if (!item || item.status !== 'FAILED') {
      throw new Error('Item not found or not in a failed state');
    }

    await this._repository.resetItemToPending(itemId);
    this._workerServiceProducer.emit('batch-schedule-item', {
      id: item.id,
      options: { delay: 0 },
      payload: { itemId: item.id },
    });
  }

  async findStalledItemIntegrationIds(staleMinutes = 15): Promise<string[]> {
    const staleBefore = dayjs().subtract(staleMinutes, 'minute').toDate();
    const stalled = await this._repository.findOverdueItems(staleBefore);
    return Array.from(new Set(stalled.map((i) => i.integrationId)));
  }

  // Self-healing recovery, mirroring the Pinterest deletion queues: a
  // delay:0 BullMQ job is still disposable delivery, not the source of
  // truth. Anything still PENDING long after being created means its job
  // was lost (Redis restart, queue flush, app deploy mid-flight) — re-emit it.
  async recoverOverdueItems(staleMinutes = 15): Promise<number> {
    const staleBefore = dayjs().subtract(staleMinutes, 'minute').toDate();
    const overdue = await this._repository.findOverdueItems(staleBefore);

    for (const item of overdue) {
      try {
        await this._workerServiceProducer.delete('batch-schedule-item', item.id);
      } catch (err) {
        // No existing job to remove — that's the case this exists for.
      }
      this._workerServiceProducer.emit('batch-schedule-item', {
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
}
