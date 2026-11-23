/**
 * Board #5285, row #2695 (a Codex PR whose review findings stayed open when it merged; released by Claude 3, taken by
 * Claude 5 Jt9): the store blog's findings still on main, each with what fails on main before the fix.
 *
 *   - Claude 4's LEVE 1: a published id with no record took the whole store map down, not only the blog's addresses.
 *   - Claude 4's LOW: a write sent and lost (mutationReply) was "unconfirmed" with nothing in the logs.
 *   - Claude 6's LOW 1: saving a post deleted in another tab answered 503 "unknown", not a definite "gone".
 *   - Claude 6's LOW 2: the unavailable page's "Try again" went back to page 1, not the page the reader was on.
 *   - Claude 7's LEVE: the feed's failed read logged nothing (the page's read is held in tests/blog-availability.test.ts,
 *     with the second count read of Claude 7's other LEVE).
 *   - Claude 4's LEVE 2: store-blog's own copy of the reply reader is gone; the blog has one reader (blogReadArray).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { POST } from "@/app/api/store/blog/route";
import { BlogUnavailable } from "@/app/[handle]/blog/blog-unavailable";
import { GET as feed } from "@/app/[handle]/blog/feed.xml/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setPostCount, storeForEmail } from "@/lib/store";
import { blogReadArray } from "@/lib/blog-read-replies";
import { deletePost, readPost, savePost } from "@/lib/store-blog";
import { storeSitemap } from "@/lib/store-sitemap";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const logged: unknown[][] = [];
console.error = (...args: unknown[]) => void logged.push(args);
const loggedNow = () => logged.splice(0).map((args) => String(args[0]));

async function main(): Promise<void> {
  redis.clear();
  const email = "blog-row-2695@example.com";
  await claimHandle(email, "blogrow", "Blog row", "");
  await ensureStatsId(email);
  const shown = await addProduct(email, "Rye Guide", "", "19", null);
  const store = (await storeForEmail(email))!;
  const statsId = store.statsId!;
  const input = { title: "A kept post", body: "Synthetic words.", product: null, draft: false };
  const id = "abcde12345";
  await savePost(statsId, null, input, () => id, ROOM);
  await setPostCount(email, 1);

  part("Claude 4's LEVE 1: a blog that does not read leaves only the blog out of the store's map");
  const healthy = await storeSitemap((await storeForEmail(email))!);
  is("set-up: the healthy map has the product and the blog", [healthy.some((e) => e.url.includes("/p/")), healthy.some((e) => e.url.endsWith("/blog"))], [true, true]);
  // A partial pipeline left the published index without the post's record: the blog cannot be read.
  await redis.pipeline([["HDEL", `nl:blog:meta:${statsId}`, id]]);
  const map = await storeSitemap((await storeForEmail(email))!).catch(() => null);
  is("the map is still drawn", Array.isArray(map), true);
  is("with the store's product page in it", Boolean(map?.some((e) => e.url.includes("/p/"))), true);
  is("and no blog address, none invented", Boolean(map?.some((e) => e.url.includes("/blog"))), false);
  is("the cause is logged", loggedNow().some((line) => /blog could not be read for its map/.test(line)), true);
  is("the inconsistent index is never removed by reading it", await redis.pipeline([["ZCARD", `nl:blog:pub:${statsId}`]]), [1]);
  is("set-up: the product is the one added", Boolean(shown), true);

  part("Claude 7's LEVE: the feed's failed read is unavailable, and its cause is logged");
  const response = await feed(new Request("https://local.example/@blogrow/blog/feed.xml"), { params: Promise.resolve({ handle: "@blogrow" }) });
  is("the feed says unavailable (503)", response.status, 503);
  is("the cause is logged", loggedNow().some((line) => /blog feed failed/.test(line)), true);
  await redis.pipeline([["ZREM", `nl:blog:pub:${statsId}`, id], ["HDEL", `nl:blog:body:${statsId}`, id]]);

  part("Claude 6's LOW 1: saving a post deleted in another tab is a definite 'gone', never 'unknown'");
  const gone = "abcde67890";
  await savePost(statsId, null, input, () => gone, ROOM);
  is("set-up: deleted in another tab", await deletePost(statsId, gone, ROOM), 0);
  const again = await savePost(statsId, gone, input, () => { throw new Error("no new id on an edit"); }, ROOM);
  is("the edit answers gone", again, { ok: false, reason: "gone" });
  is("nothing is written back under the deleted id", await readPost(statsId, gone), null);
  const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
  const route = await POST(new NextRequest("https://marktmorgen.com/api/store/blog", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify({ action: "save", id: gone, title: input.title, body: input.body, draft: false }) }));
  is("the route answers 404 gone, not 503 unknown", [route.status, ((await route.json()) as { error?: string }).error], [404, "gone"]);
  is("still nothing written back", await readPost(statsId, gone), null);
  // A record in another shape stays unknown: only a confirmed absence is gone.
  await redis.pipeline([["HSET", `nl:blog:meta:${statsId}`, gone, "not json"]]);
  is("a record that does not read stays unknown", await savePost(statsId, gone, input, () => gone, ROOM), { ok: false, reason: "unknown" });
  await redis.pipeline([["HDEL", `nl:blog:meta:${statsId}`, gone]]);
  const editor = readFileSync("components/blog-editor.tsx", "utf8");
  const words = editor.match(/\bgone:\s*"([^"]*)"/)?.[1] ?? "";
  is("the studio has words for gone", words.length > 0, true);
  is("they say it was deleted and not saved, and that the words are still there", [/deleted/.test(words), /not saved/.test(words), /still here/.test(words)], [true, true, true]);

  part("Claude 4's LOW: a write sent whose reply did not come back is unconfirmed, and the cause is logged");
  const pipeline = redis.pipeline;
  redis.pipeline = async (commands) => {
    if (commands[0]?.[0] === "HSET" && String(commands[0][1]).startsWith("nl:blog:meta:")) throw new Error("synthetic timeout after dispatch");
    return pipeline(commands);
  };
  try {
    const lost = await savePost(statsId, null, { ...input, title: "Lost reply" }, () => "abcde11111", ROOM);
    is("still unconfirmed, never retried", lost, { ok: false, reason: "unconfirmed" });
    is("the cause is logged", loggedNow().some((line) => /blog write was sent and its reply did not come back/.test(line)), true);
  } finally {
    redis.pipeline = pipeline;
  }

  part("Claude 6's LOW 2: 'Try again' asks for the page the reader was on");
  const html = (page?: number) => renderToStaticMarkup(createElement(BlogUnavailable, { language: "en", handle: "blogrow", name: "Blog row", ...(page === undefined ? {} : { page }) }));
  is("page 3 tries page 3 again", html(3).includes('href="/@blogrow/blog?page=3"'), true);
  is("page 1 tries the blog's address", html(1).includes('href="/@blogrow/blog"'), true);
  is("no page given tries the blog's address", html().includes('href="/@blogrow/blog"'), true);
  const page = readFileSync("app/[handle]/blog/page.tsx", "utf8");
  is("the blog page passes its page to the unavailable view", /<BlogUnavailable[^>]*page=\{page\}/.test(page), true);

  part("Claude 4's LEVE 2: the blog has one reply reader");
  const blog = readFileSync("lib/store-blog.ts", "utf8");
  is("store-blog keeps no copy of its own", /function blogReplies\b/.test(blog), false);
  is("the one reader refuses a Proxy", blogReadArray(new Proxy([1], {}), 1), null);
  is("and an extra field", blogReadArray(Object.assign([1], { extra: true }), 1), null);
  is("and reads a plain reply", blogReadArray([1, "a"], 2), [1, "a"]);

  done();
}

void main();
