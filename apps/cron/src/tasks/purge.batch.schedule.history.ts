import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { BatchScheduleRepository } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.repository';

const RETENTION_DAYS = 7;

@Injectable()
export class PurgeBatchScheduleHistory {
  constructor(private _batchScheduleRepository: BatchScheduleRepository) {}

  @Cron('0 3 * * *')
  async handleCron() {
    try {
      const cutoff = dayjs().subtract(RETENTION_DAYS, 'day').toDate();
      const purged =
        await this._batchScheduleRepository.purgeCompletedItemsOlderThan(cutoff);
      if (purged > 0) {
        console.log(
          `[BATCH SCHEDULE HISTORY] Purged ${purged} item(s) older than ${RETENTION_DAYS} days`
        );
      }
    } catch (err) {
      console.error('[BATCH SCHEDULE HISTORY] Error in purge cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'PurgeBatchScheduleHistory cron job failed' },
      });
    }
  }
}
