/**
 * Issue #3974 (Codex V, uploads/storage): a community post that failed before its own write left its picture taken
 * (TAKEN mark, off the sweep's list) and never swept, its place counted for good. createPost now throws
 * PostNotWritten for every failure before the post's own write (its count, its number, its room), and the route gives
 * the picture back to the member (untakeCommunityUpload): listed again for the sweep, which deletes it and gives its
 * place back a day later unless they post it again. A failure of the write itself is not PostNotWritten: the post may
 * exist, and its picture is kept, as before.
 *
 * Synthetic only: the real lib/community.ts and lib/community-files.ts, the in-memory Redis and file store.
 */
import { readFileSync } from "node:fs";
import * as community from "@/lib/community";
import { communityFolder } from "@/lib/community-image";
import { noteCommunityUpload, sweepCommunityUploads, takeCommunityUpload, untakeCommunityUpload } from "@/lib/community-files";
import { DataRoomError } from "@/lib/store-data";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { files } from "./failure-cleanup-world";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY_MS = 86_400_000;
const ID = "c".repeat(32);
const AUTHOR = "a".repeat(32);
const folder = communityFolder(ID);
const named = (c: string) => `community/${folder}/${c.repeat(32)}.webp`;
const post = (img: { path: string; w: number; h: number; alt: string } | null) => ({ space: "general", author: AUTHOR, title: "Hello", text: "A post", img, kind: "post" as const, poll: null });

/** Runs `body` with every pipeline that holds `command` answered by `answer` (a reply list, or a throw). */
async function withReply<T>(command: string, answer: unknown[] | Error, body: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: (string | number)[][]) => {
    if (batch.some((c) => c[0] === command)) {
      if (answer instanceof Error) throw answer;
      return [...answer];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = original;
  }
}
// Read from the module, so this test also runs (and fails) on code without it.
const PostNotWritten = (community as Record<string, unknown>).PostNotWritten as (abstract new (...args: never[]) => Error) | undefined;
const { createPost } = community;
const outcome = (run: () => Promise<unknown>) =>
  run().then(() => "made", (error: unknown) => (PostNotWritten && error instanceof PostNotWritten ? "not written" : error instanceof DataRoomError ? "full" : "other"));

async function main(): Promise<void> {
  const OWNER = "postnotwritten@example.com";
  await claimHandle(OWNER, "postnotwritten", "Post Not Written", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PostNotWrit1", subscriptionId: "sub_PostNotWrit1", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const error = console.error;
  console.error = () => {};
  try {
    part("Every failure before the post's own write is PostNotWritten, and nothing is written");
    const feed = `nl:cm:${ID}:feed`;
    const before = Number(redis.run(["ZCARD", feed]));
    is("its count answered in another shape", await withReply("ZCARD", ["many"], () => outcome(() => createPost(ID, post(null), store))), "not written");
    is("its count's connection lost", await withReply("ZCARD", new Error("synthetic: connection reset"), () => outcome(() => createPost(ID, post(null), store))), "not written");
    is("its number answered in another shape", await withReply("INCR", [0], () => outcome(() => createPost(ID, post(null), store))), "not written");
    is("its number's connection lost", await withReply("INCR", new Error("synthetic: connection reset"), () => outcome(() => createPost(ID, post(null), store))), "not written");
    is("its room could not be counted", await withReply("EVAL", ["garbled"], () => outcome(() => createPost(ID, post(null), store))), "not written");
    is("and no post was written by any of them", Number(redis.run(["ZCARD", feed])), before);

    part("A failure of the write itself is not PostNotWritten: the post may exist");
    is("the write's connection lost", await withReply("SET", new Error("synthetic: reply lost"), () => outcome(() => createPost(ID, post(null), store))), "other");
    is("and a healthy post is still made", await outcome(() => createPost(ID, post(null), store)), "made");

    part("A picture whose post was certainly not written goes back to the sweep, which deletes it a day later");
    const path = named("d");
    is("its door noted", await noteCommunityUpload(path, AUTHOR, Date.now()), true);
    files.set(path, { bytes: new Uint8Array(16), contentType: "image/webp", at: Date.now() });
    is("the post takes it", await takeCommunityUpload(path, AUTHOR), true);
    is("the post fails before its write", await withReply("INCR", new Error("synthetic: connection reset"), () => outcome(() => createPost(ID, post({ path, w: 10, h: 10, alt: "" }), store))), "not written");
    await untakeCommunityUpload(path, AUTHOR);
    is("the member can post it again", await takeCommunityUpload(path, AUTHOR), true);
    await untakeCommunityUpload(path, AUTHOR);
    advance(DAY_MS + 1_000);
    await sweepCommunityUploads(Date.now() + DAY_MS + 2 * 3_600_000);
    is("unposted, the sweep deletes it a day and an hour later", files.has(path), false);
  } finally {
    console.error = error;
  }

  part("The route gives the picture back only on PostNotWritten");
  const route = readFileSync("app/api/store/community/route.ts", "utf8");
  is("it gives it back to its member on PostNotWritten", route.includes("else if (error instanceof PostNotWritten && img) await untakeCommunityUpload(img.path, key)"), true);
  is("and still deletes it when the room is full", route.includes("if (error instanceof DataRoomError && img) await dropCommunityImage(img.path);"), true);
  done();
}

void main();
