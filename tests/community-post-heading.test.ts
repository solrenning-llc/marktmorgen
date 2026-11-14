/**
 * WCAG 1.3.1 and 2.4.10 (section headings) on a community post's own page:
 * the post is what the page is about, so its title is the page's one level-1
 * heading, and the comments under it (level 2) come after it. In the feed the
 * same card keeps a level-2 heading under the feed's own. The real card is
 * rendered both ways with synthetic data.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PostCard } from "@/components/community-parts";
import { freshConfig } from "@/lib/community";
import type { Store } from "@/lib/store";

const store = { handle: "synthetic-kitchen", name: "Synthetic Kitchen", language: "en", photoId: null, look: { theme: "light" } } as unknown as Store;
const config = freshConfig(store.name);
const now = Date.UTC(2026, 10, 13, 12);
const titled = { id: "p".repeat(12), n: 1, sp: config.spaces[0].id, a: "a".repeat(32), title: "Which knife should a beginner buy first?", text: "A short question.", img: null, at: now / 1000 - 3600, kind: "post", hid: false, ed: 0 };
const untitled = { ...titled, id: "q".repeat(12), title: "" };

function headings(post: typeof titled, full: boolean): { level: number; text: string }[] {
  const html = renderToStaticMarkup(createElement(PostCard as never, { store, post, config, members: new Map(), numbers: { likes: 0, liked: false, comments: 0 }, viewer: { key: "b".repeat(32), owner: false, canWrite: true }, from: full ? "post" : "feed", full } as never));
  return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map(([, level, inner]) => ({ level: Number(level), text: inner.replace(/<[^>]+>/g, "").trim() }));
}

for (const post of [titled, untitled]) {
  const own = headings(post, true);
  assert.equal(own.length, 1, "the post on its own page has one heading");
  assert.equal(own[0].level, 1, `on its own page the post's heading "${own[0].text}" is level 1`);
  assert.ok(own[0].text.length > 0, "and it has words, the title or who wrote it");
  const inFeed = headings(post, false);
  assert.deepEqual(inFeed.map((heading) => heading.level), [2], "in the feed the same post keeps a level-2 heading");
}
console.log("Community post: level 1 on its own page, level 2 in the feed, with a title or without");
