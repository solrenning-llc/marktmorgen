// lib/redis for tests/meta-disconnect-redis-off.test.ts: Redis not configured, and any command an error.
export const isRedisConfigured = () => false;
export async function redisPipeline(): Promise<unknown[]> {
  throw new Error("Redis is not configured in this world");
}
