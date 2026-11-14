/**
 * A post's picture keeps a mark in the database for as long as the post keeps it (lib/community-files.ts, after the
 * security reviews of #3414, 9 November 2026), and that mark is taken from the store's data room with the post
 * (lib/community.ts, postBytes): kept outside the room, it would be a record nothing prices.
 *
 * Synthetic only: a real store and community on the in-memory Redis.
 */
import * as pictures from "@/lib/community-files";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { createPost } from "@/lib/community";
import { dataBytes } from "@/lib/store-data-rules";
import { indexBytes } from "@/lib/community-search";
import { dataKey } from "@/lib/store-data";
import { communityFolder } from "@/lib/community-image";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "cmroom@example.com";
  await claimHandle(OWNER, "cmroomshop", "Room Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  const store = (await storeForEmail(OWNER))!;
  const id = "c".repeat(32);
  const mark = Number((pictures as Record<string, unknown>).PICTURE_MARK_BYTES);

  part("A post with a picture takes its picture's mark from the data room");
  is("the mark has a size", mark > 0, true);
  const path = `community/${communityFolder(id)}/${"e".repeat(32)}.webp`;
  const made = await createPost(id, { space: "general", author: "a".repeat(32), title: "Hello", text: "With a picture", img: { path, w: 10, h: 10, alt: "" }, kind: "post", poll: null }, store);
  if (!made.ok) throw new Error("no post");
  const key = dataKey(store)!;
  const [slot] = await redis.pipeline([["HGET", key, `cm:p:${made.post.id}`]]);
  const without = dataBytes([JSON.stringify(made.post)], 3) + indexBytes([made.post.title, made.post.text]);
  is("its slot holds the post and its picture's mark", Number(slot), without + mark);

  const plain = await createPost(id, { space: "general", author: "a".repeat(32), title: "Hello", text: "No picture", img: null, kind: "post", poll: null }, store);
  if (!plain.ok) throw new Error("no post");
  const [plainSlot] = await redis.pipeline([["HGET", key, `cm:p:${plain.post.id}`]]);
  is("a post without one takes no mark", Number(plainSlot), dataBytes([JSON.stringify(plain.post)], 3) + indexBytes([plain.post.title, plain.post.text]));
  done();
}

void main();
