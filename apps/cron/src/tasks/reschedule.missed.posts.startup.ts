import { Injectable, OnModuleInit } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class RescheduleMissedPostsStartup implements OnModuleInit {
  constructor(
    private _integrationService: IntegrationService,
    private _postsRepository: PostsRepository
  ) {}

  async onModuleInit() {
    const { logger } = Sentry;
    // Use setImmediate to run after module initialization completes
    // This prevents blocking the server startup
    setImmediate(async () => {
      try {
        console.log('[STARTUP CHECK] Starting missed posts and duplicate schedule check on server startup...');
        logger.info('Starting missed posts and duplicate schedule check on server startup...');

        // STEP 1: Check for duplicate schedules first
        console.log('[STARTUP CHECK] Step 1: Checking for duplicate schedules...');
        const duplicatesFixed = await this.checkAndFixDuplicates();
        
        if (duplicatesFixed > 0) {
          console.log(`[STARTUP CHECK] Fixed ${duplicatesFixed} duplicate schedules`);
        }

        // STEP 2: Check for missed posts
        console.log('[STARTUP CHECK] Step 2: Checking for missed posts...');
        
        // Get all active integrations across all organizations
        const activeIntegrations = await this._integrationService.getAllActiveIntegrations();

        if (!activeIntegrations || activeIntegrations.length === 0) {
          console.log('[STARTUP CHECK] No active integrations found to check for missed posts');
          logger.info('No active integrations found to check for missed posts');
          return;
        }

        console.log(
          `[STARTUP CHECK] Checking ${activeIntegrations.length} active integrations for missed posts`
        );
        logger.info(
          `Checking ${activeIntegrations.length} active integrations for missed posts`
        );

        let totalRescheduled = 0;

        // Process integrations sequentially to avoid overwhelming the system
        for (const integration of activeIntegrations) {
          try {
            // Check if this integration has any missed posts
            const missedPosts =
              await this._postsRepository.getMissedPostsForIntegration(
                integration.id
              );

            if (missedPosts.length > 0) {
              console.log(
                `[STARTUP CHECK] Found ${missedPosts.length} missed posts for integration ${integration.providerIdentifier} (${integration.name})`
              );
              logger.info(
                `Found ${missedPosts.length} missed posts for integration ${integration.providerIdentifier} (${integration.name})`
              );

              // Reschedule the missed posts
              const result =
                await this._integrationService.rescheduleMissedPostsForIntegration(
                  integration.id,
                  integration
                );

              totalRescheduled += result.rescheduled;
            }
          } catch (err) {
            console.error(
              `[STARTUP CHECK] ❌ Error processing integration ${integration.id}: ${err instanceof Error ? err.message : String(err)}`
            );
            Sentry.captureException(err, {
              extra: {
                context:
                  'Failed to check/reschedule missed posts for integration on startup',
                integrationId: integration.id,
                providerIdentifier: integration.providerIdentifier,
              },
            });
            logger.error(
              `Error processing integration ${integration.id}: ${err instanceof Error ? err.message : String(err)}`
            );
            // Continue with next integration even if this one fails
            continue;
          }
        }

        if (totalRescheduled > 0) {
          console.log(
            `[STARTUP CHECK] ✅ Complete: Rescheduled ${totalRescheduled} missed posts across ${activeIntegrations.length} integrations`
          );
          logger.info(
            `Server startup check complete: Rescheduled ${totalRescheduled} missed posts across ${activeIntegrations.length} integrations`
          );
        } else {
          console.log(
            `[STARTUP CHECK] ✅ Complete: No missed posts found across ${activeIntegrations.length} integrations`
          );
          logger.info(
            `Server startup check complete: No missed posts found across ${activeIntegrations.length} integrations`
          );
        }
      } catch (err) {
        Sentry.captureException(err, {
          extra: {
            context: 'Failed to run startup missed posts check',
          },
        });
        logger.error(
          `Error during startup missed posts check: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
  }

  // Check for and fix duplicate schedules (same integration + same time)
  private async checkAndFixDuplicates(): Promise<number> {
    const { logger } = Sentry;
    let totalFixed = 0;

    try {
      // Find all duplicate schedules
      const duplicates = await this._postsRepository.findDuplicateSchedules();

      if (duplicates.length === 0) {
        console.log('[STARTUP CHECK] No duplicate schedules found');
        return 0;
      }

      console.log(
        `[STARTUP CHECK] Found ${duplicates.length} sets of duplicate schedules`
      );

      // Process each set of duplicates
      for (const duplicate of duplicates) {
        try {
          const { integrationId, publishDate, count } = duplicate;

          console.log(
            `[STARTUP CHECK] Processing ${count} posts at same time for integration ${integrationId}`
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
            `[STARTUP CHECK] Keeping post ${posts[0].id}, rescheduling ${postsToReschedule.length} duplicate(s)`
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

            totalFixed++;
            console.log(
              `[STARTUP CHECK] ✓ Moved duplicate post ${post.id} to available time slot`
            );
            logger.info(
              `Fixed duplicate: moved post ${post.id} to ${newSlot}`
            );
          }
        } catch (err) {
          console.error(
            `[STARTUP CHECK] Error processing duplicate set: ${err instanceof Error ? err.message : String(err)}`
          );
          Sentry.captureException(err, {
            extra: {
              context: 'Failed to process duplicate schedule set on startup',
              duplicate,
            },
          });
          continue;
        }
      }

      return totalFixed;
    } catch (err) {
      console.error(
        `[STARTUP CHECK] Error checking duplicates: ${err instanceof Error ? err.message : String(err)}`
      );
      Sentry.captureException(err, {
        extra: {
          context: 'Failed to check duplicate schedules on startup',
        },
      });
      return 0;
    }
  }
}
