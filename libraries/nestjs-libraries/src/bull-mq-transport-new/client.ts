import { ClientProxy, ReadPacket, WritePacket } from '@nestjs/microservices';
import { Queue, QueueEvents } from 'bullmq';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { v4 } from 'uuid';
import { Injectable } from '@nestjs/common';

@Injectable()
export class BullMqClient extends ClientProxy {
  queues = new Map<string, Queue>();
  queueEvents = new Map<string, QueueEvents>();

  async connect(): Promise<any> {
    return;
  }

  async close() {
    return;
  }

  publish(
    packet: ReadPacket<any>,
    callback: (packet: WritePacket<any>) => void
  ) {
    // console.log('hello');
    // this.publishAsync(packet, callback);
    return () => console.log('sent');
  }

  delete(pattern: string, jobId: string) {
    console.log(`[BullMQ] Deleting job: ${jobId} from queue: ${pattern}`);
    const queue = this.getQueue(pattern);
    return queue.remove(jobId);
  }

  deleteScheduler(pattern: string, jobId: string) {
    const queue = this.getQueue(pattern);
    return queue.removeJobScheduler(jobId);
  }

  async publishAsync(
    packet: ReadPacket<any>,
    callback: (packet: WritePacket<any>) => void
  ) {
    const queue = this.getQueue(packet.pattern);
    const queueEvents = this.getQueueEvents(packet.pattern);
    const job = await queue.add(packet.pattern, packet.data, {
      jobId: packet.data.id ?? v4(),
      ...packet.data.options,
      removeOnComplete: !packet.data.options.attempts,
      removeOnFail: !packet.data.options.attempts,
    });

    try {
      await job.waitUntilFinished(queueEvents);
      console.log('success');
      callback({ response: job.returnvalue, isDisposed: true });
    } catch (err) {
      console.log('err');
      callback({ err, isDisposed: true });
    }
  }

  getQueueEvents(pattern: string) {
    return (
      this.queueEvents.get(pattern) ||
      new QueueEvents(pattern, {
        connection: ioRedis,
      })
    );
  }

  getQueue(pattern: string) {
    return (
      this.queues.get(pattern) ||
      new Queue(pattern, {
        connection: ioRedis,
      })
    );
  }

  async checkQueueHealth(queueName: string) {
    const queue = this.getQueue(queueName);
    const issues: string[] = [];

    // Check Redis connectivity
    try {
      await ioRedis.ping();
    } catch {
      return {
        valid: false,
        issues: ['Redis connection failed'],
        counts: null,
      };
    }

    // Get job counts by state
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed'
    );

    // Check for stuck waiting jobs (threshold: 10 minutes)
    const waitingJobs = await queue.getJobs('waiting' as const);
    const now = Date.now();
    const stuckThresholdMs = 10 * 60 * 1000;
    const stuckWaiting = waitingJobs.filter(
      (job) => now - job.timestamp > stuckThresholdMs
    );
    if (stuckWaiting.length > 0) {
      issues.push(
        `${stuckWaiting.length} job(s) stuck waiting for over 10 minutes`
      );
    }

    // Check for recent failed jobs (last 50 failed jobs within 15 minutes)
    const failedJobs = await queue.getJobs('failed' as const, 0, 49);
    const recentFailThresholdMs = 15 * 60 * 1000;
    const recentFailed = failedJobs.filter(
      (job) => job.finishedOn && now - job.finishedOn < recentFailThresholdMs
    );
    if (recentFailed.length >= 5) {
      issues.push(
        `${recentFailed.length} job(s) failed in the last 15 minutes`
      );
    }

    // Check for stalled/active jobs that may indicate worker issues
    // Active jobs older than 5 minutes may indicate stalled workers
    const activeJobs = await queue.getJobs('active' as const);
    const activeStallThresholdMs = 5 * 60 * 1000;
    const stalledActive = activeJobs.filter(
      (job) => now - job.timestamp > activeStallThresholdMs
    );
    if (stalledActive.length > 0) {
      issues.push(
        `${stalledActive.length} active job(s) possibly stalled (running over 5 minutes)`
      );
    }

    // Check if workers are consuming jobs — if waiting count is high
    // and no jobs are active, workers may be down
    if (counts.waiting > 10 && counts.active === 0) {
      issues.push(
        `${counts.waiting} jobs waiting but no active workers processing`
      );
    }

    return {
      valid: issues.length === 0,
      issues,
      counts,
    };
  }

  // Keep backward-compatible alias
  async checkForStuckWaitingJobs(queueName: string) {
    const result = await this.checkQueueHealth(queueName);
    return { valid: result.valid };
  }

  async dispatchEvent(packet: ReadPacket<any>): Promise<any> {
    const jobId = packet.data.id ?? v4();
    const delay = packet.data.options?.delay || 0;
    console.log(`[BullMQ] Dispatching event to queue ${packet.pattern}, jobId: ${jobId}, delay: ${delay}ms`);
    const queue = this.getQueue(packet.pattern);
    if (packet?.data?.options?.every) {
      const { every, immediately } = packet.data.options;
      const id = packet.data.id ?? v4();
      await queue.upsertJobScheduler(
        id,
        { every, ...(immediately ? { immediately } : {}) },
        {
          name: id,
          data: packet.data,
          opts: {
            removeOnComplete: true,
            removeOnFail: true,
          },
        }
      );
      return;
    }

    const finalJobId = packet.data.id ?? v4();
    await queue.add(packet.pattern, packet.data, {
      jobId: finalJobId,
      ...packet.data.options,
      removeOnComplete: true,
      removeOnFail: true,
    });
    console.log(`[BullMQ] ✓ Job ${finalJobId} added to queue ${packet.pattern}`);
  }
}
