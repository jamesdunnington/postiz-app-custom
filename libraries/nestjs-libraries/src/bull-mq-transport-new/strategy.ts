import { CustomTransportStrategy, Server } from '@nestjs/microservices';
import { Queue, Worker } from 'bullmq';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

// Per-pattern concurrency override. Everything not listed here keeps the
// default of 10. batch-schedule-item is capped at 1 (single-threaded) so a
// large CSV can't fan out into a burst of parallel image re-hosts that trips
// the source host's rate limit — pacing between items is handled by staggered
// job delays in BatchScheduleService.createBatch instead.
const PATTERN_CONCURRENCY: Record<string, number> = {
  'batch-schedule-item': 1,
};

export class BullMqServer extends Server implements CustomTransportStrategy {
  queues: Map<string, Queue>;
  workers: Worker[] = [];

  /**
   * This method is triggered when you run "app.listen()".
   */
  listen(callback: () => void) {
    this.queues = [...this.messageHandlers.keys()].reduce((all, pattern) => {
      all.set(pattern, new Queue(pattern, { connection: ioRedis }));
      return all;
    }, new Map());

    this.workers = Array.from(this.messageHandlers).map(
      ([pattern, handler]) => {
        return new Worker(
          pattern,
          async (job) => {
            const stream$ = this.transformToObservable(
              await handler(job.data.payload, job)
            );

            this.send(stream$, (packet) => {
              if (packet.err) {
                return job.discard();
              }

              return true;
            });
          },
          {
            lockDuration: 300000,
            maxStalledCount: 3,
            concurrency: PATTERN_CONCURRENCY[pattern] ?? 10,
            connection: ioRedis,
            removeOnComplete: {
              count: 0,
            },
            removeOnFail: {
              count: 0,
            },
          }
        );
      }
    );

    callback();
  }

  /**
   * This method is triggered on application shutdown.
   */
  close() {
    this.workers.map((worker) => worker.close());
    this.queues.forEach((queue) => queue.close());
    return true;
  }
}
