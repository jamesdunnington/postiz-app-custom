import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';
import * as Sentry from '@sentry/nestjs';
import dayjs from 'dayjs';

@Injectable()
export class CheckMissingQueues {
  constructor(
    private _postService: PostsService,
    private _workerServiceProducer: BullMqClient
  ) {}
  @Cron('0 * * * *')
  async handleCron() {
    const { logger } = Sentry;
    try {
      console.log('[CHECK MISSING QUEUES] Starting check for missing posts in next 3 hours...');
      logger.info('Starting check for missing posts in next 3 hours');

      const list = await this._postService.searchForMissingThreeHoursPosts();
      
      console.log(`[CHECK MISSING QUEUES] Found ${list.length} scheduled posts in next 3 hours`);
      logger.info(`Found ${list.length} scheduled posts in next 3 hours`);

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
        console.log('[CHECK MISSING QUEUES] ✅ All posts are properly queued');
        logger.info('All posts are properly queued');
        return;
      }

      console.log(`[CHECK MISSING QUEUES] ⚠️ Found ${notExists.length} posts missing from queue, adding them...`);
      logger.warn(`Found ${notExists.length} posts missing from queue`, {
        missingPosts: notExists.map(j => ({ id: j.id, publishDate: j.publishDate }))
      });

      for (const job of notExists) {
        const delay = dayjs(job.publishDate).diff(dayjs(), 'millisecond');
        console.log(`[CHECK MISSING QUEUES] Adding post ${job.id} to queue with delay ${delay}ms (${dayjs(job.publishDate).format('YYYY-MM-DD HH:mm:ss')})`);
        
        this._workerServiceProducer.emit('post', {
          id: job.id,
          options: {
            delay,
          },
          payload: {
            id: job.id,
            delay,
          },
        });
      }

      console.log(`[CHECK MISSING QUEUES] ✅ Successfully added ${notExists.length} posts to queue`);
      logger.info(`Successfully added ${notExists.length} posts to queue`);
    } catch (err) {
      console.error('[CHECK MISSING QUEUES] ❌ Error in cron job:', err);
      logger.error('Error in CheckMissingQueues cron job', { error: err });
      Sentry.captureException(err, {
        extra: {
          context: 'CheckMissingQueues cron job failed',
        },
      });
    }
  }
}
