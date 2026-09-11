import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { PinterestDeleteRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.repository';
import { PinterestBoardDeleteRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.repository';

const RETENTION_DAYS = 7;

@Injectable()
export class PurgePinterestDeleteHistory {
  constructor(
    private _pinterestDeleteRepository: PinterestDeleteRepository,
    private _pinterestBoardDeleteRepository: PinterestBoardDeleteRepository
  ) {}

  @Cron('0 3 * * *')
  async handleCron() {
    try {
      const cutoff = dayjs().subtract(RETENTION_DAYS, 'day').toDate();
      const purgedPins =
        await this._pinterestDeleteRepository.purgeCompletedItemsOlderThan(
          cutoff
        );
      const purgedBoards =
        await this._pinterestBoardDeleteRepository.purgeCompletedItemsOlderThan(
          cutoff
        );
      if (purgedPins > 0 || purgedBoards > 0) {
        console.log(
          `[PINTEREST DELETE HISTORY] Purged ${purgedPins} pin item(s) and ${purgedBoards} board item(s) older than ${RETENTION_DAYS} days`
        );
      }
    } catch (err) {
      console.error('[PINTEREST DELETE HISTORY] Error in purge cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'PurgePinterestDeleteHistory cron job failed' },
      });
    }
  }
}
