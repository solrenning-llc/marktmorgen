// Minimal Upstash Redis client over the REST API (no extra dependency).
// Accepts either the Upstash variable names or the Vercel KV names.
// Each pipeline is given up after REDIS_TIMEOUT_MS (lib/fetch-timeout.ts),
// failing as a network failure does, so no page or job hangs on Redis.
// redisOutcomeOf tells, beside the error a call threw, whether Redis may have applied it.
import { REDIS_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";

type Command = (string | number)[];

function getConfig() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

export function isRedisConfigured(): boolean {
  return getConfig() !== null;
}

/**
 * What a failed call says about whether Redis applied it (rule 24), for a caller that would give back
 * something (a mark, a slot, a reservation) only when the write is known not to have landed. The errors
 * redisPipeline and redisPipelineBase64 throw are exactly what they always were (same class, message and
 * cause); redisOutcomeOf(error) reads, beside them, which of these it was:
 *
 *   not-sent       nothing reached Redis: no Redis is configured, there was no time left to ask (fetch was
 *                  never called), or fetch failed before any connection was made (the name did not resolve,
 *                  ENOTFOUND/EAI_AGAIN; the connection was refused, ECONNREFUSED; or connecting timed out,
 *                  UND_ERR_CONNECT_TIMEOUT): a request is written only on a connection that was made.
 *   refused        Redis answered every command, one plain entry for each, and refused at least one: each
 *                  answer says applied (with its reply) or refused (with Redis's error). A refused command
 *                  changed nothing. A pipeline is not a transaction: the other commands of the same call were
 *                  applied or refused on their own, as their answers say.
 *   maybe-applied  anything else, which may have been done: a timeout or a connection lost after the request
 *                  was handed to fetch (a write given up on by the client can still reach Redis later), an
 *                  answer cut short or of another shape, any HTTP error status (what each Upstash status means
 *                  is not read here, so none is taken as a refusal), and a script or transaction that raised
 *                  (EVAL, EVALSHA, FCALL and their _RO forms, EXEC: Redis does not undo what a script wrote
 *                  before its error). Also any error these calls did not throw, and any other value.
 */
export type RedisAnswer = Readonly<{ applied: true; result: unknown }> | Readonly<{ applied: false; error: string }>;
export type RedisOutcome =
  | Readonly<{ kind: "not-sent" }>
  | Readonly<{ kind: "maybe-applied" }>
  | Readonly<{ kind: "refused"; answers: readonly RedisAnswer[] }>;

const NOT_SENT: RedisOutcome = Object.freeze({ kind: "not-sent" });
const MAYBE_APPLIED: RedisOutcome = Object.freeze({ kind: "maybe-applied" });
const outcomes = new WeakMap<object, RedisOutcome>();
/** Codes of a connection that was never made, so no request was written on it. */
const NEVER_CONNECTED = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]);
/** Commands whose error reply can follow writes they already made. */
const RAISES_AFTER_WRITING = new Set(["EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO", "EXEC"]);

/** Whether the error redisPipeline or redisPipelineBase64 threw was not sent, refused or maybe applied. */
export function redisOutcomeOf(error: unknown): RedisOutcome {
  return (typeof error === "object" && error !== null) || typeof error === "function" ? outcomes.get(error) ?? MAYBE_APPLIED : MAYBE_APPLIED;
}

/** An own data property, read without running a getter; undefined otherwise. */
function ownValue(holder: object, name: string): unknown {
  const slot = Object.getOwnPropertyDescriptor(holder, name);
  return slot && Object.hasOwn(slot, "value") ? slot.value : undefined;
}

/** fetch's own TypeError for a connection that was never made. */
function neverConnected(error: unknown): boolean {
  if (!(error instanceof TypeError) || ownValue(error, "message") !== "fetch failed") return false;
  const cause = ownValue(error, "cause");
  if (typeof cause !== "object" || cause === null) return false;
  const code = ownValue(cause, "code");
  return typeof code === "string" && NEVER_CONNECTED.has(code);
}

/** The answers of a pipeline Redis refused part of: exactly one plain entry per command, else maybe applied. */
function refusal(commands: Command[], results: unknown): RedisOutcome {
  if (!Array.isArray(results) || results.length !== commands.length) return MAYBE_APPLIED;
  const answers: RedisAnswer[] = [];
  for (let i = 0; i < commands.length; i += 1) {
    const entry: unknown = ownValue(results, String(i));
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return MAYBE_APPLIED;
    const keys = Object.keys(entry);
    if (keys.length !== 1) return MAYBE_APPLIED;
    if (keys[0] === "result") {
      answers.push(Object.freeze({ applied: true, result: ownValue(entry, "result") }));
      continue;
    }
    const error = ownValue(entry, "error");
    if (keys[0] !== "error" || typeof error !== "string" || error === "") return MAYBE_APPLIED;
    if (RAISES_AFTER_WRITING.has(String(commands[i]?.[0]).toUpperCase())) return MAYBE_APPLIED;
    answers.push(Object.freeze({ applied: false, error }));
  }
  return Object.freeze({ kind: "refused", answers: Object.freeze(answers) });
}

/** One call's progress: whether fetch was called, and what Redis answered when it refused a command. */
type Call = { sent: boolean; refused: RedisOutcome | null };

/** The error as it was thrown, with what it says about the call kept beside it. */
function told(call: Call, error: unknown): unknown {
  const outcome = call.refused ?? (call.sent && !neverConnected(error) ? MAYBE_APPLIED : NOT_SENT);
  if ((typeof error === "object" && error !== null) || typeof error === "function") outcomes.set(error, outcome);
  return error;
}

export async function redisPipeline(commands: Command[]): Promise<unknown[]> {
  const call: Call = { sent: false, refused: null };
  try {
    const config = getConfig();
    if (!config) throw new Error("Redis is not configured");

    const results = await timed(REDIS_TIMEOUT_MS, async (signal) => {
      const body = JSON.stringify(commands);
      call.sent = true;
      const response = await fetch(`${config.url}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body,
        cache: "no-store",
        signal,
      });

      if (!response.ok) {
        throw new Error(`Redis request failed with status ${response.status}`);
      }

      return (await response.json()) as {
        result?: unknown;
        error?: string;
      }[];
    });
    const failed = results.find((item) => item.error);
    if (failed) {
      call.refused = refusal(commands, results);
      throw new Error(`Redis error: ${failed.error}`);
    }

    return results.map((item) => item.result);
  } catch (error) {
    throw told(call, error);
  }
}

/**
 * A pipeline whose string answers come back base64-encoded ("Upstash-Encoding: base64",
 * https://upstash.com/docs/redis/features/restapi, read 31 October 2026): for binary answers such as DUMP's, which
 * the plain JSON answer would corrupt. Every string in the answer is base64 except "OK"; numbers and nulls are as
 * they are. Bounded by the same timeout as redisPipeline.
 */
export async function redisPipelineBase64(commands: Command[]): Promise<unknown[]> {
  const call: Call = { sent: false, refused: null };
  try {
    const config = getConfig();
    if (!config) throw new Error("Redis is not configured");
    const results = await timed(REDIS_TIMEOUT_MS, async (signal) => {
      const body = JSON.stringify(commands);
      call.sent = true;
      const response = await fetch(`${config.url}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", "Upstash-Encoding": "base64" },
        body,
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error(`Redis request failed with status ${response.status}`);
      return (await response.json()) as { result?: unknown; error?: string }[];
    });
    return results.map((entry) => {
      if (entry.error) {
        call.refused = refusal(commands, results);
        throw new Error(`Redis error: ${entry.error}`);
      }
      return entry.result;
    });
  } catch (error) {
    throw told(call, error);
  }
}
