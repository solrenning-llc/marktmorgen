// Minimal Upstash Redis client over the REST API (no extra dependency).
// Accepts either the Upstash variable names or the Vercel KV names.
// Each pipeline is given up after REDIS_TIMEOUT_MS (lib/fetch-timeout.ts),
// failing as a network failure does, so no page or job hangs on Redis.
import { REDIS_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { UnknownReplyError } from "@/lib/redis-reply";

type Command = (string | number)[];

function getConfig() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/** Upstash REST returns one single-field result/error envelope per command, in order.
 * https://upstash.com/docs/redis/features/restapi (checked November 5, 2026).
 * A malformed or incomplete batch is unknown, even if an earlier write succeeded: UnknownReplyError, so a route that
 * tells it apart answers "unavailable", while a real Redis error stays an Error (Claude 5 on #2509).
 */
function pipelineResults(value: unknown, expected: number): unknown[] {
  if (!Array.isArray(value) || value.length !== expected) throw new UnknownReplyError("a pipeline with a missing or extra reply");
  const results: unknown[] = [];
  for (let i = 0; i < expected; i += 1) {
    const entry: unknown = value[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 1) throw new UnknownReplyError("a reply envelope");
    const error = Object.getOwnPropertyDescriptor(entry, "error");
    if (error && "value" in error && typeof error.value === "string" && error.value.length > 0) throw new Error(`Redis error: ${error.value}`);
    const result = Object.getOwnPropertyDescriptor(entry, "result");
    if (!result || !("value" in result) || result.value === undefined) throw new UnknownReplyError("a reply with no result");
    results.push(result.value);
  }
  return results;
}

export function isRedisConfigured(): boolean {
  return getConfig() !== null;
}

export async function redisPipeline(commands: Command[]): Promise<unknown[]> {
  const config = getConfig();
  if (!config) throw new Error("Redis is not configured");

  const results = await timed(REDIS_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`${config.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      cache: "no-store",
      signal,
    });

    if (!response.ok) {
      throw new Error(`Redis request failed with status ${response.status}`);
    }

    return (await response.json()) as unknown;
  });
  return pipelineResults(results, commands.length);
}

/**
 * A pipeline whose string answers come back base64-encoded ("Upstash-Encoding: base64",
 * https://upstash.com/docs/redis/features/restapi, read 31 October 2026): for binary answers such as DUMP's, which
 * the plain JSON answer would corrupt. Every string in the answer is base64 except "OK"; numbers and nulls are as
 * they are. Bounded by the same timeout as redisPipeline.
 */
export async function redisPipelineBase64(commands: Command[]): Promise<unknown[]> {
  const config = getConfig();
  if (!config) throw new Error("Redis is not configured");
  const results = await timed(REDIS_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`${config.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", "Upstash-Encoding": "base64" },
      body: JSON.stringify(commands),
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error(`Redis request failed with status ${response.status}`);
    return (await response.json()) as unknown;
  });
  return pipelineResults(results, commands.length);
}
