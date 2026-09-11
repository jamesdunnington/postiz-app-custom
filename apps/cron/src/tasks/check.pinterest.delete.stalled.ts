import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';
import { PinterestBoardDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.service';

// Self-healing, not just monitoring: a delayed BullMQ job is disposable
// delivery for a queued deletion, not the source of truth (the DB row's
// scheduledFor is). If that job is ever lost — Redis restarted without
// persistence, the queue flushed, an app deploy landing mid-flight — this
// re-emits it so an app upgrade/restart can never permanently strand an
// already-queued pin or board deletion.
@Injectable()
export class CheckPinterestDeleteStalled {
  constructor(
    private _pinterestDeleteService: PinterestDeleteService,
    private _pinterestBoardDeleteService: PinterestBoardDeleteService
  ) {}

  @Cron('*/5 * * * *')
  async handleCron() {
    try {
      const recoveredPins =
        await this._pinterestDeleteService.recoverOverdueItems();
      if (recoveredPins > 0) {
        console.warn(
          `[PINTEREST DELETE] Recovered ${recoveredPins} overdue pin-deletion item(s) whose BullMQ job was missing or lost`
        );
        Sentry.captureMessage(
          'Pinterest pin-delete queue: recovered overdue item(s)',
          { extra: { recoveredPins } }
        );
      }

      const recoveredBoards =
        await this._pinterestBoardDeleteService.recoverOverdueItems();
      if (recoveredBoards > 0) {
        console.warn(
          `[PINTEREST DELETE] Recovered ${recoveredBoards} overdue board-deletion item(s) whose BullMQ job was missing or lost`
        );
        Sentry.captureMessage(
          'Pinterest board-delete queue: recovered overdue item(s)',
          { extra: { recoveredBoards } }
        );
      }
    } catch (err) {
      console.error('[PINTEREST DELETE] Error in stalled-item recovery cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'CheckPinterestDeleteStalled cron job failed' },
      });
    }
  }
}
