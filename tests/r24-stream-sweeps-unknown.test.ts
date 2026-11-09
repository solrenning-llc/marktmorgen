/**
 * The five-minute video job and the daily usage run read three lists from
 * Redis: the videos due a look and the videos still to delete (lib/stream.ts
 * sweep), the videos whose AI captions are due a look (lib/auto-captions.ts
 * sweepAutoCaptions), and the stores whose video was watched in a month
 * (lib/watch.ts watchedFolders). A reply that is missing, cut short or of
 * another shape is not an empty list (CX-123 rule 24): it is unknown, the
 * reader throws UnknownReplyError, and the job says it failed rather than
 * reporting "nothing due", "no captions to settle" or "no store watched".
 * An exact empty list still reads as empty.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sweepAutoCaptions } from "@/lib/auto-captions";
import { UnknownReplyError } from "@/lib/redis-reply";
import { sweep } from "@/lib/stream";
import { watchedFolders } from "@/lib/watch";
import { store as redis } from "./redis-stub";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.UPSTASH_REDIS_REST_TOKEN ??= "stub-token";
process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";

type Pipeline = typeof redis.pipeline;

const FOLDER_A = "0123456789abcdef0123456789abcdef";
const FOLDER_B = "fedcba9876543210fedcba9876543210";

/** Pipeline replies that are not an exact list: a missing slot, a status, a member that is not a string, an object, a hole. */
const UNKNOWN: [string, unknown[]][] = [
  ["missing pipeline slot", []],
  ["status instead of a list", ["OK"]],
  ["a member that is not a string", [[7]]],
  ["an object", [{}]],
  ["a list with a hole", [new Array(1)]],
  ["two slots for one command", [[], []]],
];

/** Runs `read` with the one command `name` (and, when given, on key `key`) answered by `reply`; asserts it was asked. */
async function withReply<T>(name: string, key: string | null, reply: unknown[], read: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis) as Pipeline;
  let injected = false;
  redis.pipeline = (async (commands) => {
    if (commands.length === 1 && commands[0]?.[0] === name && (key === null || commands[0]?.[1] === key)) {
      injected = true;
      return reply as unknown[];
    }
    return original(commands);
  }) as Pipeline;
  try {
    const out = await read();
    assert.equal(injected, true, `the ${name} read must be exercised`);
    return out;
  } finally {
    redis.pipeline = original;
  }
}

async function throwsUnknown(read: () => Promise<unknown>): Promise<void> {
  await assert.rejects(read, (error: unknown) => error instanceof UnknownReplyError);
}

for (const [label, reply] of UNKNOWN) {
  test(`watchedFolders: ${label} is unknown, never "no store watched"`, async () => {
    await throwsUnknown(() => withReply("SMEMBERS", null, reply, () => watchedFolders("2026-11")));
  });
  test(`stream sweep: due list ${label} is unknown, never "no video due"`, async () => {
    await throwsUnknown(() => withReply("ZRANGEBYSCORE", "nl:stream:due", reply, () => sweep(Date.now() + 5_000)));
  });
  test(`stream sweep: delete list ${label} is unknown, never "nothing to delete"`, async () => {
    await throwsUnknown(() =>
      withReply("ZRANGEBYSCORE", "nl:stream:due", [[]], () =>
        withReply("SMEMBERS", "nl:stream:gone", reply, () => sweep(Date.now() + 5_000)),
      ),
    );
  });
  test(`sweepAutoCaptions: due list ${label} is unknown, never "no captions due"`, async () => {
    await throwsUnknown(() => withReply("ZRANGEBYSCORE", null, reply, () => sweepAutoCaptions(Date.now() + 5_000)));
  });
}

test("watchedFolders: an exact set is read, sorted, with what is not a folder left out", async () => {
  const got = await withReply("SMEMBERS", null, [[FOLDER_B, "not-a-folder", FOLDER_A]], () => watchedFolders("2026-11"));
  assert.deepEqual(got, [FOLDER_A, FOLDER_B]);
});

test("watchedFolders: an exact empty set is no store watched", async () => {
  assert.deepEqual(await withReply("SMEMBERS", null, [[]], () => watchedFolders("2026-11")), []);
});

test("stream sweep: exact empty lists look at nothing and delete nothing", async () => {
  const counts = await withReply("ZRANGEBYSCORE", "nl:stream:due", [[]], () =>
    withReply("SMEMBERS", "nl:stream:gone", [[]], () => sweep(Date.now() + 5_000)),
  );
  assert.deepEqual(counts, { looked: 0, ready: 0, failed: 0, deleted: 0 });
});

test("sweepAutoCaptions: an exact empty queue looks at nothing", async () => {
  const counts = await withReply("ZRANGEBYSCORE", null, [[]], () => sweepAutoCaptions(Date.now() + 5_000));
  assert.deepEqual(counts, { looked: 0, done: 0 });
});
