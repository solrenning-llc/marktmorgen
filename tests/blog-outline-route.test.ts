/**
 * The blog route never publishes a post with an outline's prompt left in
 * (487 [IT4], item 5; lib/blog-outline.ts), called as the studio calls it,
 * on the in-memory store: refused as published, before anything is saved;
 * kept as a draft; refused again when that draft, or a published post, is
 * published with a prompt in it; taken once every prompt is replaced.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/blog/route";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { allPosts, readPost } from "@/lib/store-blog";
import { BLOG_OUTLINES } from "@/lib/blog-outline";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const OWNER = "owner@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "outlineshop", "Outline Shop", "Recipes.");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/blog", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as { ok: boolean; error?: string; post?: { id: string } } };
  };
  const outline = BLOG_OUTLINES[1].body;
  const mine = outline.replace(/\[[^\]\n]+\]/g, "My own words.");

  const refused = await call({ action: "save", title: "Mistakes", body: outline, draft: false });
  is("published with prompts: refused, and nothing saved", [refused.status, refused.data.error, (await allPosts(store.statsId!)).length], [400, "outline_left", 0]);
  is("a prompt in the title only is refused too", (await call({ action: "save", title: "[The first mistake]", body: mine, draft: false })).data.error, "outline_left");

  const draft = await call({ action: "save", title: "Mistakes", body: outline, draft: true });
  const id = draft.data.post?.id ?? "";
  is("kept as a draft, prompts and all", [draft.data.ok, (await readPost(store.statsId!, id))?.draft, (await readPost(store.statsId!, id))?.body.includes("[The first mistake]")], [true, true, true]);
  is("that draft published with prompts still in it: refused, still a draft", [(await call({ action: "save", id, title: "Mistakes", body: outline, draft: false })).data.error, (await readPost(store.statsId!, id))?.draft], ["outline_left", true]);

  const published = await call({ action: "save", id, title: "Mistakes", body: mine, draft: false });
  is("every prompt replaced: published", [published.data.ok, (await readPost(store.statsId!, id))?.draft], [true, false]);
  is("a published post edited to hold a prompt again: refused, and the published words kept", [(await call({ action: "save", id, title: "Mistakes", body: `${mine}\n\n[One sentence your reader should remember.]`, draft: false })).data.error, (await readPost(store.statsId!, id))?.body.includes("[One sentence")], ["outline_left", false]);
  is("the creator's own brackets are published", (await call({ action: "save", title: "[Updated] My guide", body: "Read the [2026 edition] first.", draft: false })).data.ok, true);
  done();
}

void main();
