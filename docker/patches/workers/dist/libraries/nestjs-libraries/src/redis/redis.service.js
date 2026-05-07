"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ioRedis = void 0;
const ioredis_1 = require("ioredis");
class MockRedis {
    constructor() { this.data = new Map(); }
    async get(key) { return this.data.get(key); }
    async set(key, value) { this.data.set(key, value); return 'OK'; }
    async del(key) { this.data.delete(key); return 1; }
}
exports.ioRedis = process.env.REDIS_URL
    ? new ioredis_1.Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        connectTimeout: 10000,
        keepAlive: 30000,
    })
    : new MockRedis();
