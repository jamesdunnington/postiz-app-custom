import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';
import * as Sentry from '@sentry/nestjs';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

@Injectable()
export class CheckDuplicateSchedules {
  constructor(
    private _postsRepository: PostsRepository,
    private _integrationService: IntegrationService,
    private _bullMqClient: BullMqClient
  ) {}

  @Cron('0 * * * *') // Run every hour at minute 0
  async handleCron() {
    const { logger } = Sentry;
    try {
      console.log('[DUPLICATE CHECK] Starting duplicate schedule check...');
      logger.info('Starting duplicate schedule check');

      // Find all duplicate schedules (same integration + same publishDate)
      const duplicates = await this._postsRepository.findDuplicateSchedules();

      if (duplicates.length === 0) {
        console.log('[DUPLICATE CHECK] ✅ No duplicate schedules found');
        logger.info('No duplicate schedules found');
        return;
      }

      console.log(
        `[DUPLICATE CHECK] ⚠️ Found ${duplicates.length} sets of duplicate schedules`
      );
      logger.warn(`Found ${duplicates.length} sets of duplicate schedules`);

      let totalFixed = 0;

      // Process each set of duplicates
      for (const duplicate of duplicates) {
        try {
          const { integrationId, publishDate, count } = duplicate;

          console.log(
            `[DUPLICATE CHECK] Processing ${count} posts scheduled at ${dayjs(publishDate).format('YYYY-MM-DD HH:mm')} for integration ${integrationId}`
          );

          // Get the integration details
          const integration = await this._integrationService.getIntegrationByIdOnly(
            integrationId
          );

          if (!integration) {
            logger.warn(`Integration ${integrationId} not found, skipping`);
            continue;
          }

          // Get posting times for this integration
          const postingTimes = JSON.parse(integration.postingTimes || '[]');

          if (postingTimes.length === 0) {
            logger.warn(
              `No posting times configured for integration ${integrationId}, skipping`
            );
            continue;
          }

          // Get all posts in this duplicate set
          const posts = await this._postsRepository.getPostsByIntegrationAndDate(
            integrationId,
            publishDate
          );

          // Keep the first post, reschedule the rest
          const postsToReschedule = posts.slice(1);

          console.log(
            `[DUPLICATE CHECK] Keeping post ${posts[0].id}, rescheduling ${postsToReschedule.length} duplicate(s)`
          );

          // Reschedule duplicate posts one at a time
          for (const post of postsToReschedule) {
            const availableSlot =
              await this._postsRepository.getNextAvailableSlots(
                post.organizationId,
                integrationId,
                1,
                postingTimes
              );

            if (availableSlot.length === 0) {
              logger.warn(
                `No available slot found for duplicate post ${post.id}`
              );
              continue;
            }

            const newSlot = availableSlot[0];

            // Update the post's publish date
            await this._postsRepository.updatePostPublishDate(post.id, newSlot);

            // Re-queue the post in the worker
            this._bullMqClient.emit('post', {
              id: post.id,
              options: {
                delay: dayjs(newSlot).diff(dayjs(), 'millisecond'),
              },
              payload: {
                id: post.id,
              },
            });

            totalFixed++;
            console.log(
              `[DUPLICATE CHECK] ✓ Rescheduled post ${post.id} from ${dayjs(publishDate).format('YYYY-MM-DD HH:mm')} to ${dayjs(newSlot).format('YYYY-MM-DD HH:mm')}`
            );
            logger.info(
              `Rescheduled duplicate post ${post.id} to ${dayjs(newSlot).format('YYYY-MM-DD HH:mm')}`
            );
          }
        } catch (err) {
          console.error(
            `[DUPLICATE CHECK] ❌ Error processing duplicate set: ${err instanceof Error ? err.message : String(err)}`
          );
          Sentry.captureException(err, {
            extra: {
              context: 'Failed to process duplicate schedule set',
              duplicate,
            },
          });
          // Continue with next set
          continue;
        }
      }

      console.log(
        `[DUPLICATE CHECK] ✅ Complete: Fixed ${totalFixed} duplicate schedules`
      );
      logger.info(`Duplicate check complete: Fixed ${totalFixed} duplicates`);
    } catch (err) {
      console.error(
        `[DUPLICATE CHECK] ❌ Error during duplicate check: ${err instanceof Error ? err.message : String(err)}`
      );
      Sentry.captureException(err, {
        extra: {
          context: 'Failed to run duplicate schedule check',
        },
      });
      logger.error(
        `Error during duplicate check: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
