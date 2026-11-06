import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import PostPage, { generateMetadata } from "../app/[handle]/blog/[post]/page";
import StudioBlogPage from "../app/studio/blog/page";
import { claimHandle, ensureStatsId, storeForEmail } from "../lib/store";
import { wordsIn } from "../lib/buyer-words";
import { type Post } from "../lib/store-blog";
import { configure } from "./blog-read-page-world";
import { store as redis } from "./redis-stub";

redis.clear();
const value: Post = { id: "0000000001", title: "Fictional bread guide", excerpt: "Synthetic post", draft: false, publishedAt: 1000, updatedAt: 1000, minutes: 1, body: "Complete fictional words.", product: null };
const params = { params: Promise.resolve({ handle: "@blogpageproof", post: "fictional-bread-guide-0000000001" }) };
const fixture = (async () => {
  const owner = "blog-page-proof@example.test";
  assert.equal((await claimHandle(owner, "blogpageproof", "Fictional blog", "Synthetic page proof.")).ok, true);
  await ensureStatsId(owner);
  const shop = await storeForEmail(owner);
  assert.ok(shop);
  return shop;
})();

test("actual post page and metadata say temporarily unavailable in all seven buyer languages", async () => {
  const shop = await fixture;
  for (const language of ["en", "es", "fr", "de", "it", "nl", "pt"] as const) {
    configure({ ...shop, language }, value, "post");
    const meta = await generateMetadata(params);
    assert.equal(meta.title, `${wordsIn(language).notAvailable} — ${shop.name}`);
    assert.deepEqual(meta.robots, { index: false, follow: true });
    const html = renderToStaticMarkup(await PostPage(params));
    assert.ok(html.includes(wordsIn(language).notAvailable));
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /BlogPosting|Complete fictional words/);
  }
});

test("a confirmed absent post still follows the actual not-found path", async () => {
  configure(await fixture, value, "absent");
  assert.deepEqual(await generateMetadata(params), { title: "Not found — Marktmorgen" });
  await assert.rejects(() => PostPage(params), /SYNTHETIC_NOT_FOUND/);
});

test("healthy actual post page keeps its words, article metadata and canonical URL", async () => {
  configure(await fixture, value, "none");
  const meta = await generateMetadata(params);
  assert.match(String(meta.title), /Fictional bread guide/);
  assert.ok(meta.alternates?.canonical);
  const html = renderToStaticMarkup(await PostPage(params));
  assert.match(html, /Complete fictional words/);
  assert.match(html, /BlogPosting/);
});

test("actual studio page never labels an unread list as Posts (0) or no posts", async () => {
  configure(await fixture, value, "list");
  const html = renderToStaticMarkup(await StudioBlogPage({ searchParams: Promise.resolve({ edit: "new" }) }));
  assert.match(html, /Posts couldn&#x27;t be loaded\. Reload to try again\./);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /Posts \(0\)|No posts yet|data-synthetic-editor/);
});

test("actual studio page keeps the known list but never opens an empty editor for an unread post", async () => {
  configure(await fixture, value, "post");
  const html = renderToStaticMarkup(await StudioBlogPage({ searchParams: Promise.resolve({ edit: value.id }) }));
  assert.match(html, /Fictional bread guide/);
  assert.match(html, /This post couldn&#x27;t be loaded\. Reload to try again\./);
  assert.doesNotMatch(html, /data-synthetic-editor/);
});

test("healthy studio editing still opens the actual editor slot", async () => {
  configure(await fixture, value, "none");
  const html = renderToStaticMarkup(await StudioBlogPage({ searchParams: Promise.resolve({ edit: value.id }) }));
  assert.match(html, /data-synthetic-editor="true"/);
});
