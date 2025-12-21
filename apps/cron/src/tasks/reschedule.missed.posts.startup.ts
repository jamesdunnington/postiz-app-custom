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
        logger.info('Starting missed posts check on server startup...');

        // Get all active integrations (not disabled, not in between steps, no refresh needed)
        const integrations = await this._integrationService.getIntegrationsList('');

        if (!integrations || integrations.length === 0) {
          logger.info('No integrations found to check for missed posts');
          return;
        }

        const activeIntegrations = integrations.filter(
          (integration: any) =>
            !integration.disabled &&
            !integration.inBetweenSteps &&
            !integration.refreshNeeded &&
            integration.type === 'social'
        );

        if (activeIntegrations.length === 0) {
          logger.info('No active social integrations found');
          return;
        }

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
          logger.info(
            `Server startup check complete: Rescheduled ${totalRescheduled} missed posts across ${activeIntegrations.length} integrations`
          );
        } else {
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
}
