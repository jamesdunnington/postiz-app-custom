import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { BatchScheduleService } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.service';

@Injectable()
export class CheckBatchScheduleStalled {
  constructor(private _batchScheduleService: BatchScheduleService) {}

  @Cron('*/5 * * * *')
  async handleCron() {
    try {
      const recovered = await this._batchScheduleService.recoverOverdueItems();
      if (recovered > 0) {
        console.warn(
          `[BATCH SCHEDULE] Recovered ${recovered} overdue item(s) whose BullMQ job was missing or lost`
        );
        Sentry.captureMessage(
          'Batch schedule queue: recovered overdue item(s)',
          { extra: { recovered } }
        );
      }
    } catch (err) {
      console.error('[BATCH SCHEDULE] Error in stalled-item recovery cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'CheckBatchScheduleStalled cron job failed' },
      });
    }
  }
}
