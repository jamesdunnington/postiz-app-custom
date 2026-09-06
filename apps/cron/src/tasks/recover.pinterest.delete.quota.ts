import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';

@Injectable()
export class RecoverPinterestDeleteQuota {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}

  @Cron('*/5 * * * *')
  async handleCron() {
    try {
      const recovered =
        await this._pinterestDeleteService.recoverDueQuotaWaits();
      if (recovered > 0) {
        console.log(
          `[PINTEREST DELETE QUOTA] Recovered ${recovered} item(s) whose daily-cap wait has elapsed`
        );
      }

      const stalledIntegrationIds =
        await this._pinterestDeleteService.findStalledItemIntegrationIds();
      if (stalledIntegrationIds.length > 0) {
        console.warn(
          `[PINTEREST DELETE QUOTA] ${stalledIntegrationIds.length} integration(s) have stalled bulk-delete items`,
          { stalledIntegrationIds }
        );
        Sentry.captureMessage('Pinterest bulk-delete queue appears stalled', {
          extra: { stalledIntegrationIds },
        });
      }
    } catch (err) {
      console.error('[PINTEREST DELETE QUOTA] Error in cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'RecoverPinterestDeleteQuota cron job failed' },
      });
    }
  }
}
