import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { PinterestMoveRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-move/pinterest-move.repository';

const RETENTION_DAYS = 7;

@Injectable()
export class PurgePinterestMoveHistory {
  constructor(private _pinterestMoveRepository: PinterestMoveRepository) {}

  @Cron('0 3 * * *')
  async handleCron() {
    try {
      const cutoff = dayjs().subtract(RETENTION_DAYS, 'day').toDate();
      const purgedPins =
        await this._pinterestMoveRepository.purgeCompletedItemsOlderThan(
          cutoff
        );
      if (purgedPins > 0) {
        console.log(
          `[PINTEREST MOVE HISTORY] Purged ${purgedPins} pin item(s) older than ${RETENTION_DAYS} days`
        );
      }
    } catch (err) {
      console.error('[PINTEREST MOVE HISTORY] Error in purge cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'PurgePinterestMoveHistory cron job failed' },
      });
    }
  }
}
