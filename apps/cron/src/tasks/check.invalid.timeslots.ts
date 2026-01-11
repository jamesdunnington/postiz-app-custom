import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class CheckInvalidTimeSlots {
  constructor(private _integrationService: IntegrationService) {}

  @Cron('55 * * * *') // Run every hour at minute 55 (5 minutes before duplicate check)
  async handleCron() {
    const { logger } = Sentry;
    try {
      console.log('[INVALID TIME SLOTS] Starting hourly validation check...');
      logger.info('Starting hourly invalid time slot check');

      const result = await this._integrationService.rescheduleInvalidTimeSlots();

      if (result.rescheduled > 0) {
        console.log(
          `[INVALID TIME SLOTS] ✅ Hourly check complete: Rescheduled ${result.rescheduled} of ${result.checked} posts to valid time slots`
        );
        logger.info(
          `Hourly invalid time slot check complete: Rescheduled ${result.rescheduled} posts`
        );
      } else {
        console.log('[INVALID TIME SLOTS] ✅ No posts at invalid time slots');
        logger.info('No posts at invalid time slots');
      }
    } catch (err) {
      console.error(
        `[INVALID TIME SLOTS] ❌ Error during hourly check: ${err instanceof Error ? err.message : String(err)}`
      );
      Sentry.captureException(err, {
        extra: {
          context: 'Failed hourly invalid time slot check',
        },
      });
      logger.error(
        `Error during hourly invalid time slot check: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
