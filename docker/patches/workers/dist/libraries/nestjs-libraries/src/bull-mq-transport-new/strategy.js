"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BullMqServer = void 0;
const microservices_1 = require("@nestjs/microservices");
const bullmq_1 = require("bullmq");
const redis_service_1 = require("../redis/redis.service");
class BullMqServer extends microservices_1.Server {
    constructor() {
        super(...arguments);
        this.workers = [];
    }
    listen(callback) {
        this.queues = [...this.messageHandlers.keys()].reduce((all, pattern) => {
            all.set(pattern, new bullmq_1.Queue(pattern, { connection: redis_service_1.ioRedis }));
            return all;
        }, new Map());
        this.workers = Array.from(this.messageHandlers).map(([pattern, handler]) => {
            return new bullmq_1.Worker(pattern, async (job) => {
                const stream$ = this.transformToObservable(await handler(job.data.payload, job));
                this.send(stream$, (packet) => {
                    if (packet.err) {
                        return job.discard();
                    }
                    return true;
                });
            }, {
                lockDuration: 300000,
                maxStalledCount: 3,
                concurrency: 10,
                connection: redis_service_1.ioRedis,
                removeOnComplete: { count: 0 },
                removeOnFail: { count: 0 },
            });
        });
        callback();
    }
    close() {
        this.workers.map((worker) => worker.close());
        this.queues.forEach((queue) => queue.close());
        return true;
    }
}
exports.BullMqServer = BullMqServer;
