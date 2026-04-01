import { Injectable, OnModuleInit } from '@nestjs/common';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class CleanupOrphanedMediaStartup implements OnModuleInit {
  constructor(private _mediaService: MediaService) {}

  async onModuleInit() {
    // Delay to let other services initialize first
    setTimeout(() => {
      this.cleanupOrphanedMedia();
    }, 15000);
  }

  async cleanupOrphanedMedia() {
    const { logger } = Sentry;
    console.log(
      '[MEDIA CLEANUP] Starting orphaned media cleanup on startup...'
    );
    logger.info('Starting orphaned media cleanup on startup');

    try {
      // Step 1: Purge all soft-deleted media records from the database
      const purged = await this._mediaService.purgeDeletedMedia();
      console.log(
        `[MEDIA CLEANUP] Purged ${purged.count} soft-deleted media records`
      );
      logger.info(`Purged soft-deleted media records`, {
        count: purged.count,
      });

      // Step 2: Validate remaining active media — check if files still exist
      const activeMedia = await this._mediaService.getAllActiveMedia();
      console.log(
        `[MEDIA CLEANUP] Validating ${activeMedia.length} active media records (50 concurrent)...`
      );

      const orphanedIds: string[] = [];
      const BATCH_SIZE = 50;

      for (let i = 0; i < activeMedia.length; i += BATCH_SIZE) {
        const batch = activeMedia.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (media) => {
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 3000);
              const response = await fetch(media.path, {
                method: 'HEAD',
                signal: controller.signal,
              });
              clearTimeout(timeout);
              if (!response.ok) return media.id;
              return null;
            } catch {
              return media.id;
            }
          })
        );

        for (const result of results) {
          if (result.status === 'fulfilled' && result.value) {
            orphanedIds.push(result.value);
          }
        }

        if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= activeMedia.length) {
          console.log(
            `[MEDIA CLEANUP] Progress: ${Math.min(i + BATCH_SIZE, activeMedia.length)}/${activeMedia.length} checked, ${orphanedIds.length} orphaned so far`
          );
        }

        // Batch delete orphaned records every 500 to avoid holding too many IDs in memory
        if (orphanedIds.length >= 500) {
          await this._mediaService.softDeleteMediaByIds(orphanedIds.splice(0));
        }
      }

      if (orphanedIds.length > 0) {
        await this._mediaService.softDeleteMediaByIds(orphanedIds);
        // Then purge them immediately
        await this._mediaService.purgeDeletedMedia();
        console.log(
          `[MEDIA CLEANUP] Removed ${orphanedIds.length} orphaned media records (files no longer exist)`
        );
        logger.warn(`Removed orphaned media records`, {
          count: orphanedIds.length,
        });
      } else {
        console.log('[MEDIA CLEANUP] No orphaned media found');
      }

      const totalCleaned = purged.count + orphanedIds.length;
      console.log(
        `[MEDIA CLEANUP] ✅ Complete - Total cleaned: ${totalCleaned} (${purged.count} soft-deleted + ${orphanedIds.length} orphaned)`
      );
      logger.info('Media cleanup complete', {
        softDeleted: purged.count,
        orphaned: orphanedIds.length,
        totalCleaned,
      });
    } catch (err) {
      console.error('[MEDIA CLEANUP] ❌ Error during cleanup:', err);
      logger.error('Error during media cleanup', { error: err });
      Sentry.captureException(err, {
        extra: { context: 'CleanupOrphanedMediaStartup failed' },
      });
    }
  }
}
