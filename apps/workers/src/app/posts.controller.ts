import { Controller } from '@nestjs/common';
import { EventPattern, Transport } from '@nestjs/microservices';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { WebhooksService } from '@gitroom/nestjs-libraries/database/prisma/webhooks/webhooks.service';
import { AutopostService } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.service';
import * as Sentry from '@sentry/nestjs';

@Controller()
export class PostsController {
  constructor(
    private _postsService: PostsService,
    private _webhooksService: WebhooksService,
    private _autopostsService: AutopostService
  ) {}

  @EventPattern('post', Transport.REDIS)
  async post(data: { id: string }) {
    const { logger } = Sentry;
    console.log('[WORKER] Processing post job:', data);
    logger.info('Processing post job', { postId: data.id });
    
    try {
      const result = await this._postsService.post(data.id);
      console.log('[WORKER] ✅ Successfully processed post:', data.id);
      logger.info('Successfully processed post', { postId: data.id });
      return result;
    } catch (err) {
      console.error('[WORKER] ❌ Error processing post:', data.id, err);
      logger.error('Error processing post', { postId: data.id, error: err });
      Sentry.captureException(err, {
        extra: {
          context: 'Post worker failed',
          postId: data.id,
        },
      });
    }
  }

  @EventPattern('submit', Transport.REDIS)
  async payout(data: { id: string; releaseURL: string }) {
    try {
      return await this._postsService.payout(data.id, data.releaseURL);
    } catch (err) {
      console.log(
        "Unhandled error, let's avoid crashing the submit worker",
        err
      );
    }
  }

  @EventPattern('sendDigestEmail', Transport.REDIS)
  async sendDigestEmail(data: { subject: string; org: string; since: string }) {
    try {
      return await this._postsService.sendDigestEmail(
        data.subject,
        data.org,
        data.since
      );
    } catch (err) {
      console.log(
        "Unhandled error, let's avoid crashing the digest worker",
        err
      );
    }
  }

  @EventPattern('webhooks', Transport.REDIS)
  async webhooks(data: { org: string; since: string }) {
    try {
      return await this._webhooksService.fireWebhooks(data.org, data.since);
    } catch (err) {
      console.log(
        "Unhandled error, let's avoid crashing the webhooks worker",
        err
      );
    }
  }

  @EventPattern('cron', Transport.REDIS)
  async cron(data: { id: string }) {
    try {
      return await this._autopostsService.startAutopost(data.id);
    } catch (err) {
      console.log(
        "Unhandled error, let's avoid crashing the autopost worker",
        err
      );
    }
  }
}
