import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';

@Injectable()
export class CheckPinterestDeleteStalled {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}

  @Cron('*/5 * * * *')
  async handleCron() {
    try {
      const stalledIntegrationIds =
        await this._pinterestDeleteService.findStalledItemIntegrationIds();
      if (stalledIntegrationIds.length > 0) {
        console.warn(
          `[PINTEREST DELETE] ${stalledIntegrationIds.length} integration(s) have overdue pending pin-deletion items`,
          { stalledIntegrationIds }
        );
        Sentry.captureMessage('Pinterest pin-delete queue appears stalled', {
          extra: { stalledIntegrationIds },
        });
      }
    } catch (err) {
      console.error('[PINTEREST DELETE] Error in stalled-check cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'CheckPinterestDeleteStalled cron job failed' },
      });
    }
  }
}
