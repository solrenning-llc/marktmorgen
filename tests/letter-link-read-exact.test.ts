/**
 * The emailed link to read an email kept for members (lib/letter-access.ts, readLetterGrant; the route
 * app/api/store/letters/open) reads its grant exactly (rule 24): a GET answered nil is a link that is gone, but a reply
 * lost or in another shape is unknown, never "gone". Before, any reply that was not text answered 410 "This link has
 * expired", so a buyer with a valid link was told to ask for a new one on a Redis blip. Now readLetterGrant throws
 * UnknownReplyError and the route answers 503 with the "try again" words, and nothing is spent. Synthetic only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { readLetterGrant } from "@/lib/letter-access";
import { UnknownReplyError } from "@/lib/redis-reply";
import { letterWords } from "@/lib/buyer-words/letters";
import { GET } from "@/app/api/store/letters/open/route";

const TOKEN = "a".repeat(64);
const real = redis.pipeline.bind(redis);
let odd: unknown = undefined;
const sent: string[] = [];
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sent.push(String(command[0]));
  if (odd !== undefined && commands.length === 1 && commands[0][0] === "GET") return odd === "LOST" ? [] : [odd];
  return real(commands);
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  odd = undefined;
  sent.length = 0;
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
});

const open = () => GET(new NextRequest(`https://marktmorgen.com/api/store/letters/open?token=${TOKEN}`, { headers: { "accept-language": "en-US" } }));

for (const reply of [1, {}, ["x"], true, "LOST"]) {
  test(`a link whose grant reads ${JSON.stringify(reply)} is unknown, never gone`, async () => {
    odd = reply;
    await assert.rejects(readLetterGrant(TOKEN), UnknownReplyError);
    const answer = await open();
    assert.equal(answer.status, 503);
    assert.equal(await answer.text(), letterWords("en").linkBusy);
    assert.deepEqual(sent.filter((command) => command !== "GET"), []);
  });
}

test("a link whose grant is gone (GET nil) is still gone", async () => {
  odd = null;
  assert.equal(await readLetterGrant(TOKEN), null);
  const answer = await open();
  assert.equal(answer.status, 410);
});

test("a link that is not one still writes nothing and is gone", async () => {
  const answer = await open();
  assert.equal(answer.status, 410);
});

// The store the link names is read exactly too (Claude 1 and H2 on #3779): the handle's reply lost or in another
// shape is "try again" (503), never "expired" (410), and nothing is spent; nil (the handle gone) is still gone.
import { createHash } from "node:crypto";
async function grantFor(handle: string): Promise<void> {
  const key = `nl:letters:link:${createHash("sha256").update(`nimbus-letter:${TOKEN}`).digest("hex").slice(0, 40)}`;
  await real([["SET", key, JSON.stringify({ e: "reader@example.com", k: "anykey", h: handle, l: "0123456789abcdef0123" })]]);
}
let handleOdd: unknown = undefined;
const plain = redis.pipeline;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (handleOdd !== undefined && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:store:handle:")) return handleOdd === "LOST" ? [] : [handleOdd];
  return plain(commands);
}) as typeof redis.pipeline;

for (const reply of [{}, [], 1, "LOST"]) {
  test(`the store's handle read as ${JSON.stringify(reply)}: try again, never expired`, async () => {
    await grantFor("harbor");
    handleOdd = reply;
    try {
      const answer = await open();
      assert.equal(answer.status, 503);
      assert.equal(await answer.text(), letterWords("en").linkBusy);
    } finally {
      handleOdd = undefined;
    }
  });
}

test("the store's handle gone (GET nil): still gone", async () => {
  await grantFor("harbor");
  handleOdd = null;
  try {
    assert.equal((await open()).status, 410);
  } finally {
    handleOdd = undefined;
  }
});
