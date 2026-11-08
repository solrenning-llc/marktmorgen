/**
 * The only Redis a journey builder in scripts/ may reach: the throwaway one
 * its Python wrapper serves on loopback (scripts/test_*_redis.py), with that
 * wrapper's synthetic token. Anything else — a shell that still holds the
 * production address or token, or the Vercel KV names lib/redis.ts falls back
 * to — is refused before anything is built or sent, so a journey, or a
 * FLUSHDB, never reaches real data.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Why `env` is not the loopback throwaway with `token`; null when it is. */
export function loopbackRedisProblem(env, token) {
  if (env.KV_REST_API_URL || env.KV_REST_API_TOKEN) {
    return "Refused: KV_REST_API_URL/KV_REST_API_TOKEN are set. This runs only against the loopback Redis its Python wrapper serves, with the synthetic token; unset them.";
  }
  const raw = env.UPSTASH_REDIS_REST_URL ?? "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "Refused: UPSTASH_REDIS_REST_URL is not the loopback Redis its Python wrapper serves.";
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK.has(url.hostname) || url.username || url.password) {
    return `Refused: ${url.hostname || "(no host)"} is not loopback. This runs only against the Redis its Python wrapper serves on 127.0.0.1.`;
  }
  if (env.UPSTASH_REDIS_REST_TOKEN !== token) {
    return "Refused: UPSTASH_REDIS_REST_TOKEN is not the synthetic token its Python wrapper sets.";
  }
  return null;
}

/** Stops the process, with the reason, unless `env` is the loopback throwaway with `token`. */
export function requireLoopbackRedis(env, token) {
  const problem = loopbackRedisProblem(env, token);
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  return { url: env.UPSTASH_REDIS_REST_URL.replace(/\/+$/, ""), token };
}
