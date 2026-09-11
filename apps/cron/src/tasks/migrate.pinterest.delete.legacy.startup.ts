import { Injectable, OnModuleInit } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';

// One-time cutover migration, run once on boot: any PinterestDeleteItem row
// still carrying a status from the old daily-quota model ("QUEUED" or
// "WAITING_FOR_QUOTA", both retired) gets folded into the new chained-slot
// timer so items queued before this deploy are never silently stranded.
// Idempotent — after the first successful run there are no legacy rows
// left, so every later restart is a fast no-op query.
@Injectable()
export class MigratePinterestDeleteLegacyStartup implements OnModuleInit {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}

  onModuleInit() {
    setImmediate(async () => {
      try {
        const migrated = await this._pinterestDeleteService.migrateLegacyItems();
        if (migrated > 0) {
          console.log(
            `[STARTUP CHECK] Migrated ${migrated} pre-cutover Pinterest pin-delete item(s) onto the new timed queue`
          );
        }
      } catch (err) {
        console.error(
          '[STARTUP CHECK] Error migrating legacy Pinterest pin-delete items:',
          err
        );
        Sentry.captureException(err, {
          extra: { context: 'MigratePinterestDeleteLegacyStartup failed' },
        });
      }
    });
  }
}
