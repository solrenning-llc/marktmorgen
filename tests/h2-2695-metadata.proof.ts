/** Actual blog reader and RSS route: unreadable metadata is not confirmed published content. */
import { claimHandle, ensureStatsId, setPostCount, storeForEmail } from "@/lib/store";
import { publishedPosts, readPost, savePost } from "@/lib/store-blog";
import { GET as feed } from "@/app/[handle]/blog/feed.xml/route";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";
async function main(): Promise<void> {
  redis.clear();
  const email = "metadata-proof@example.test";
  await claimHandle(email, "metadataproof", "Synthetic blog", "");
  await ensureStatsId(email); await setPostCount(email, 1);
  const store = (await storeForEmail(email))!;
  const id = "abcde12345";
  const saved = await savePost(store.statsId, null, { title: "A kept post", body: "Synthetic words.", product: null, draft: false }, () => id, ROOM);
  if (!saved.ok) throw Error("synthetic save failed");
  const key = `nl:blog:meta:${store.statsId}`;
  const [raw] = await redis.pipeline([["HGET", key, id]]);
  const valid = JSON.parse(String(raw)) as Record<string, unknown>;
  is("confirmed published metadata remains readable", (await publishedPosts(store.statsId, 1)).posts.length, 1);
  part("Unknown persisted visibility and dates must refuse the whole public reading");
  for (const [name, field, value] of [["visibility", "draft", "true"], ["date text", "publishedAt", "not-a-date"], ["overflow date", "publishedAt", "1e309"]] as const) {
    await redis.pipeline([["HSET", key, id, JSON.stringify({ ...valid, [field]: value })]]);
    let rejected = false;
    try { await publishedPosts(store.statsId, 1); } catch { rejected = true; }
    is(`${name} remains unknown before projection`, rejected, true);
  }
  const response = await feed(new Request("https://example.test/@metadataproof/blog/feed.xml"), { params: Promise.resolve({ handle: "@metadataproof" }) });
  const xml = await response.text();
  is("actual RSS route refuses the invalid date with retryable503", response.status, 503);
  is("RSS never presents Invalid Date as a confirmed publication date", xml.includes("Invalid Date"), false);
  const post = (await publishedPosts(store.statsId, 1).catch(() => null))?.posts[0];
  let safeDate = true;
  if (post) { try { new Date(post.publishedAt * 1000).toISOString(); } catch { safeDate = false; } }
  is("accepted metadata cannot throw at the actual page date projection", safeDate, true);
  await redis.pipeline([["HSET", key, id, String(raw)]]);
  is("restoring valid metadata preserves the actual stored post", (await publishedPosts(store.statsId, 1)).posts[0]?.id, id);
  part("A record read under one id cannot authorize overwriting another confirmed post");
  const otherId = "abcde67890";
  const other = await savePost(store.statsId, null, { title: "Other confirmed post", body: "Other content stays.", product: null, draft: false }, () => otherId, ROOM);
  is("the other confirmed post exists", other.ok, true);
  await redis.pipeline([["HSET", key, id, JSON.stringify({ ...valid, id: otherId })]]);
  const changed = await savePost(store.statsId, id, { title: "Change only the requested post", body: "Replacement for the requested id.", product: null, draft: false }, () => { throw Error("updating must not allocate a new id"); }, ROOM);
  is("mismatched stored identity refuses the update", changed.ok, false);
  is("the other confirmed post is never overwritten", (await readPost(store.statsId, otherId))?.body, "Other content stays.");
  done();
}
void main().catch(error => { console.error(error); process.exit(1); });
