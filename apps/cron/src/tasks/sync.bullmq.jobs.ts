import { Injectable, OnModuleInit } from '@nestjs/common';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';
import * as Sentry from '@sentry/nestjs';
import dayjs from 'dayjs';

@Injectable()
export class SyncBullMqJobs implements OnModuleInit {
  constructor(
    private _postsRepository: PostsRepository,
    private _workerServiceProducer: BullMqClient
  ) {}

  async onModuleInit() {
    // Run sync on startup after a short delay to let other services initialize
    setTimeout(() => {
      this.syncAllQueuedPosts();
    }, 10000); // 10 second delay
  }

  /**
   * Syncs all QUEUE posts with BullMQ - ensures every post has a job with correct delay
   * This fixes issues where database publishDate was updated but BullMQ job wasn't
   */
  async syncAllQueuedPosts() {
    const { logger } = Sentry;
    console.log('[SYNC BULLMQ] Starting full sync of BullMQ jobs with database...');
    logger.info('Starting full sync of BullMQ jobs with database');

    try {
      // Get all QUEUE posts scheduled for the future (next 30 days)
      const queuedPosts = await this._postsRepository.getAllQueuedPostsForSync();
      
      console.log(`[SYNC BULLMQ] Found ${queuedPosts.length} QUEUE posts to sync`);
      logger.info(`Found ${queuedPosts.length} QUEUE posts to sync`);

      let synced = 0;
      let skipped = 0;
      let errors = 0;

      for (const post of queuedPosts) {
        try {
          const now = dayjs();
          const publishDate = dayjs(post.publishDate);
          
          // Skip posts in the past (they should be handled by missed posts logic)
          if (publishDate.isBefore(now)) {
            skipped++;
            continue;
          }

          const delay = publishDate.diff(now, 'millisecond');

          // Delete any existing job for this post
          await this._workerServiceProducer.delete('post', post.id);

          // Add new job with correct delay
          this._workerServiceProducer.emit('post', {
            id: post.id,
            options: {
              delay,
            },
            payload: {
              id: post.id,
              delay,
            },
          });

          synced++;
          
          // Log progress every 100 posts
          if (synced % 100 === 0) {
            console.log(`[SYNC BULLMQ] Progress: ${synced} posts synced...`);
          }
        } catch (err) {
          errors++;
          console.error(`[SYNC BULLMQ] Error syncing post ${post.id}:`, err);
        }
      }

      console.log(`[SYNC BULLMQ] ✅ Complete - Synced: ${synced}, Skipped (past): ${skipped}, Errors: ${errors}`);
      logger.info(`BullMQ sync complete`, { synced, skipped, errors });

      return { synced, skipped, errors };
    } catch (err) {
      console.error('[SYNC BULLMQ] ❌ Error during sync:', err);
      logger.error('Error during BullMQ sync', { error: err });
      Sentry.captureException(err, {
        extra: {
          context: 'SyncBullMqJobs failed',
        },
      });
      return { synced: 0, skipped: 0, errors: 1 };
    }
  }
}
