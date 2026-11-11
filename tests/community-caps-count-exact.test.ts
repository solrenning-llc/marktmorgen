/**
 * A community's caps (lib/community.ts): createPost reads the feed's ZCARD against MAX_POSTS, and addComment
 * the post's HLEN against MAX_COMMENTS_PER_POST, before writing. A reply in another shape (text, a negative or
 * fractional number, nil, a lost reply) read as Number(...) slipped past the cap as NaN or 0, so the post or
 * comment was written over it (rule 24, MR: unknown is never under the cap). Now it throws UnknownReplyError
 * and nothing is written. Synthetic only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { addComment, createPost, readConfig } from "@/lib/community";
import { UnknownReplyError } from "@/lib/redis-reply";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { NextRequest } from "next/server";
import { POST as manage } from "@/app/api/store/community/manage/route";

const real = redis.pipeline.bind(redis);
let odd: { command: string; reply: unknown } | null = null;
const sent: string[] = [];
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sent.push(String(command[0]));
  if (odd && commands.length === 1 && commands[0][0] === odd.command) {
    if (odd.reply === "LOST") return [];
    return [odd.reply];
  }
  return real(commands);
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  odd = null;
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
});

async function community(): Promise<{ id: string; space: string; room: Parameters<typeof createPost>[2] }> {
  const OWNER = "capsexact@example.com";
  await claimHandle(OWNER, "capsexactshop", "Caps Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  const store0 = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  await manage(new NextRequest("https://marktmorgen.com/api/store/community/manage", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store0.sid, cookie }, body: JSON.stringify({ action: "enable", on: true }) }));
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  return { id, space: (await readConfig(id))!.spaces[0].id, room: { ...store, statsId: store.statsId } as Parameters<typeof createPost>[2] };
}

const post = (space: string) => ({ space, author: "a".repeat(32), title: "Hello", text: "Hello", img: null, kind: "post" as const, poll: null });

for (const reply of ["3", "many", -1, 2.5, null, "LOST"]) {
  test(`a post whose feed count reads ${JSON.stringify(reply)} is refused as unknown and nothing is written`, async () => {
    const { id, space, room } = await community();
    odd = { command: "ZCARD", reply };
    sent.length = 0;
    await assert.rejects(createPost(id, post(space), room), UnknownReplyError);
    assert.deepEqual(sent.filter((c) => c !== "ZCARD"), []);
  });

  test(`a comment whose post's comment count reads ${JSON.stringify(reply)} is refused as unknown and nothing is written`, async () => {
    const { id, space, room } = await community();
    const made = await createPost(id, post(space), room);
    assert.ok(made.ok);
    odd = { command: "HLEN", reply };
    sent.length = 0;
    await assert.rejects(addComment(id, made.post.id, { parent: "", author: "c".repeat(32), text: "Nice" }, room), UnknownReplyError);
    assert.deepEqual(sent.filter((c) => c !== "HLEN"), []);
  });
}

test("readable counts still post and comment", async () => {
  const { id, space, room } = await community();
  const made = await createPost(id, post(space), room);
  assert.ok(made.ok);
  const said = await addComment(id, made.post.id, { parent: "", author: "c".repeat(32), text: "Nice" }, room);
  assert.ok(said.ok);
});

// The post's number (INCR of the community's sequence) feeds the feed's ZADD score: a reply in another shape read
// as Number(...) gave NaN, the post was written with "n":null and its room taken, and the ZADD was refused, so it
// sat outside the feed (Claude 3, cloud D, on #3716). A number below 1 is not one INCR can give either.
for (const reply of ["3", "many", -1, 0, 2.5, null, "LOST"]) {
  test(`a post whose number reads ${JSON.stringify(reply)} is refused as unknown and nothing is written`, async () => {
    const { id, space, room } = await community();
    odd = { command: "INCR", reply };
    sent.length = 0;
    await assert.rejects(createPost(id, post(space), room), UnknownReplyError);
    assert.deepEqual(sent.filter((c) => c !== "ZCARD" && c !== "INCR"), []);
  });
}
