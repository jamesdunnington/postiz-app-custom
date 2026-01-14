import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class PostNowPendingQueues {
  constructor(
    private _postService: PostsService,
    private _workerServiceProducer: BullMqClient
  ) {}
  @Cron('*/16 * * * *')
  async handleCron() {
    const { logger } = Sentry;
    try {
      console.log('[POST NOW PENDING] Starting check for pending posts (15-30 minutes old)...');
      logger.info('Starting check for pending posts (15-30 minutes old)');

      const list = await this._postService.checkPending15minutesBack();
      
      console.log(`[POST NOW PENDING] Found ${list.length} pending posts from 15-30 minutes ago`);
      logger.info(`Found ${list.length} pending posts from 15-30 minutes ago`);

      const notExists = (
        await Promise.all(
          list.map(async (p) => ({
            id: p.id,
            publishDate: p.publishDate,
            isJob:
              ['delayed', 'waiting'].indexOf(
                await this._workerServiceProducer
                  .getQueue('post')
                  .getJobState(p.id)
              ) > -1,
          }))
        )
      ).filter((p) => !p.isJob);

      if (notExists.length === 0) {
        console.log('[POST NOW PENDING] ✅ All pending posts are properly queued');
        logger.info('All pending posts are properly queued');
        return;
      }

      console.log(`[POST NOW PENDING] ⚠️ Found ${notExists.length} pending posts missing from queue, adding them immediately...`);
      logger.warn(`Found ${notExists.length} pending posts missing from queue`, {
        missingPosts: notExists.map(j => ({ id: j.id, publishDate: j.publishDate }))
      });

      for (const job of notExists) {
        console.log(`[POST NOW PENDING] Adding pending post ${job.id} to queue immediately`);
        
        this._workerServiceProducer.emit('post', {
          id: job.id,
          options: {
            delay: 0,
          },
          payload: {
            id: job.id,
            delay: 0,
          },
        });
      }

      console.log(`[POST NOW PENDING] ✅ Successfully added ${notExists.length} pending posts to queue`);
      logger.info(`Successfully added ${notExists.length} pending posts to queue`);
    } catch (err) {
      console.error('[POST NOW PENDING] ❌ Error in cron job:', err);
      logger.error('Error in PostNowPendingQueues cron job', { error: err });
      Sentry.captureException(err, {
        extra: {
          context: 'PostNowPendingQueues cron job failed',
        },
      });
    }
  }
}
