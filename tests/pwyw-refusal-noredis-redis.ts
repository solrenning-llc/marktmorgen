/** lib/redis.ts with Redis not configured, for tests/pwyw-refusal-noredis.test.ts: nothing is ever asked of it. */
export const isRedisConfigured = () => false;
export const redisPipeline = async () => { throw new Error("no redis"); };
export const redisPipelineBase64 = redisPipeline;
