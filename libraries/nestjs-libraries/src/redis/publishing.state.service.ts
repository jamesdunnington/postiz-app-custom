import { Injectable } from '@nestjs/common';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

@Injectable()
export class PublishingStateService {
  private readonly KEY = 'publishing:paused';

  async isPaused(): Promise<boolean> {
    return (await ioRedis.get(this.KEY)) === '1';
  }

  async setPaused(paused: boolean): Promise<void> {
    if (paused) {
      await ioRedis.set(this.KEY, '1');
    } else {
      await ioRedis.del(this.KEY);
    }
  }
}
