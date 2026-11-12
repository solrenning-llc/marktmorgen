/**
 * A Redis read that cannot be understood is not proof that a video has no
 * captions. This reader distinguishes a confirmed empty hash from an
 * unavailable/corrupt answer only when the whole pipeline reply is exact.
 * The studio page still catches this error as an empty result; that UI
 * fallback is outside this reader's contract and is not fixed by this test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { streamCaptions } from "@/lib/stream";
import { store as redis } from "./redis-stub";

const FOLDER = "0123456789abcdef0123456789abcdef";
const LESSON = "abcdefghij12";
const VIDEO = "00000000-0000-4000-8000-000000000123";
const PATHNAME = `stream/${FOLDER}/${LESSON}/${VIDEO}`;
const CAPTIONS = `nl:stream:cap:${VIDEO}`;

type Pipeline = typeof redis.pipeline;

async function withCaptionReply(reply: unknown, read: () => Promise<void>): Promise<void> {
  const original = redis.pipeline.bind(redis) as Pipeline;
  let injected = false;
  redis.pipeline = (async commands => {
    if (commands.length === 1 && commands[0]?.[0] === "HGETALL" && commands[0]?.[1] === CAPTIONS) {
      injected = true;
      return reply as unknown[];
    }
    return original(commands);
  }) as Pipeline;
  try {
    await read();
    assert.equal(injected, true, "the stored-caption read must be exercised");
  } finally {
    redis.pipeline = original;
  }
}

for (const [label, reply] of [
  ["missing pipeline slot", []],
  ["extra pipeline slot", [[], []]],
  ["non-list hash", [null]],
  ["odd hash fields", [["en"]]],
  ["non-string hash value", [["en", 1]]],
  ["unknown stored language", [["not-a-language", "Unknown"]]],
] as const) {
  test(`streamCaptions refuses ${label} instead of reporting no captions`, async () => {
    await withCaptionReply(reply, async () => {
      await assert.rejects(streamCaptions([PATHNAME]), { name: "UnknownReplyError" });
    });
  });
}

test("streamCaptions still distinguishes a confirmed empty hash from a known caption", async () => {
  redis.clear();
  assert.deepEqual(await streamCaptions([PATHNAME]), {});
  await redis.pipeline([["HSET", CAPTIONS, "en", "English"]]);
  assert.deepEqual(await streamCaptions([PATHNAME]), {
    [PATHNAME]: [{ lang: "en", label: "English" }],
  });
});
