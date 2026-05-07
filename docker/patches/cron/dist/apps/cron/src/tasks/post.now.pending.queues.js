"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostNowPendingQueues = void 0;
const tslib_1 = require("tslib");
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const posts_service_1 = require("../../../../libraries/nestjs-libraries/src/database/prisma/posts/posts.service");
const client_1 = require("../../../../libraries/nestjs-libraries/src/bull-mq-transport-new/client");
const Sentry = tslib_1.__importStar(require("@sentry/nestjs"));
let PostNowPendingQueues = class PostNowPendingQueues {
    constructor(_postService, _workerServiceProducer) {
        this._postService = _postService;
        this._workerServiceProducer = _workerServiceProducer;
    }
    async handleCron() {
        const { logger } = Sentry;
        try {
            console.log('[POST NOW PENDING] Starting check for pending posts (15 min - 2 hours old)...');
            logger.info('Starting check for pending posts (15 min - 2 hours old)');
            const list = await this._postService.checkPending15minutesBack();
            console.log(`[POST NOW PENDING] Found ${list.length} pending posts overdue (15 min - 2 hours)`);
            logger.info(`Found ${list.length} pending posts overdue (15 min - 2 hours)`);
            const notExists = (await Promise.all(list.map(async (p) => ({
                id: p.id,
                publishDate: p.publishDate,
                isJob: ['delayed', 'waiting'].indexOf(await this._workerServiceProducer
                    .getQueue('post')
                    .getJobState(p.id)) > -1,
            })))).filter((p) => !p.isJob);
            if (notExists.length === 0) {
                console.log('[POST NOW PENDING] All pending posts are properly queued');
                logger.info('All pending posts are properly queued');
                return;
            }
            console.log(`[POST NOW PENDING] Found ${notExists.length} pending posts missing from queue, adding them immediately...`);
            logger.warn(`Found ${notExists.length} pending posts missing from queue`, {
                missingPosts: notExists.map(j => ({ id: j.id, publishDate: j.publishDate }))
            });
            for (const job of notExists) {
                console.log(`[POST NOW PENDING] Adding pending post ${job.id} to queue immediately`);
                this._workerServiceProducer.emit('post', {
                    id: job.id,
                    options: { delay: 0 },
                    payload: { id: job.id, delay: 0 },
                });
            }
            console.log(`[POST NOW PENDING] Successfully added ${notExists.length} pending posts to queue`);
            logger.info(`Successfully added ${notExists.length} pending posts to queue`);
        }
        catch (err) {
            console.error('[POST NOW PENDING] Error in cron job:', err);
            logger.error('Error in PostNowPendingQueues cron job', { error: err });
            Sentry.captureException(err, { extra: { context: 'PostNowPendingQueues cron job failed' } });
        }
    }
};
exports.PostNowPendingQueues = PostNowPendingQueues;
tslib_1.__decorate([
    (0, schedule_1.Cron)('*/16 * * * *'),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", Promise)
], PostNowPendingQueues.prototype, "handleCron", null);
exports.PostNowPendingQueues = PostNowPendingQueues = tslib_1.__decorate([
    (0, common_1.Injectable)(),
], PostNowPendingQueues);
