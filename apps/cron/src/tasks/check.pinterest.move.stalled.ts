import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { PinterestMoveService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-move/pinterest-move.service';

// Self-healing, not just monitoring: a delayed BullMQ job is disposable
// delivery for a queued move, not the source of truth (the DB row's
// scheduledFor is). If that job is ever lost — Redis restarted without
// persistence, the queue flushed, an app deploy landing mid-flight — this
// re-emits it so an app upgrade/restart can never permanently strand an
// already-queued pin move.
@Injectable()
export class CheckPinterestMoveStalled {
  constructor(private _pinterestMoveService: PinterestMoveService) {}

  @Cron('*/5 * * * *')
  async handleCron() {
    try {
      const recoveredPins =
        await this._pinterestMoveService.recoverOverdueItems();
      if (recoveredPins > 0) {
        console.warn(
          `[PINTEREST MOVE] Recovered ${recoveredPins} overdue pin-move item(s) whose BullMQ job was missing or lost`
        );
        Sentry.captureMessage(
          'Pinterest pin-move queue: recovered overdue item(s)',
          { extra: { recoveredPins } }
        );
      }
    } catch (err) {
      console.error('[PINTEREST MOVE] Error in stalled-item recovery cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'CheckPinterestMoveStalled cron job failed' },
      });
    }
  }
}
