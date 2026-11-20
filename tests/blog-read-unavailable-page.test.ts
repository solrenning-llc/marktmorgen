import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import PostPage, { generateMetadata } from "../app/[handle]/blog/[post]/page";
import StudioBlogPage from "../app/studio/blog/page";
import BlogPage from "../app/[handle]/blog/page";
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
  assert.doesNotMatch(html, /Posts \(0\)|No posts yet/);
  assert.match(html, /data-synthetic-editor="true" data-post-id="new" data-post-title="" data-post-body=""/);
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

test("an unread list still offers a new post without claiming the list is empty", async () => {
  configure(await fixture, value, "list");
  const html = renderToStaticMarkup(await StudioBlogPage({ searchParams: Promise.resolve({}) }));
  assert.match(html, /Posts couldn&#x27;t be loaded\. Reload to try again\./);
  assert.doesNotMatch(html, /Posts \(0\)|No posts yet/);
  assert.match(html, /href="\/studio\/blog\?edit=new"/);
  assert.match(html, /Your post list is unavailable\. You can still start a new post\./);
});

test("a new editor does not depend on reading every previous post", async () => {
  configure(await fixture, value, "list");
  const html = renderToStaticMarkup(await StudioBlogPage({ searchParams: Promise.resolve({ edit: "new" }) }));
  assert.match(html, /Posts couldn&#x27;t be loaded\. Reload to try again\./);
  assert.doesNotMatch(html, /Posts \(0\)|No posts yet/);
  assert.match(html, /data-synthetic-editor="true" data-post-id="new" data-post-title="" data-post-body=""/);
});

test("an independently readable post keeps its complete editor when the list is unread", async () => {
  configure(await fixture, value, "list");
  const html = renderToStaticMarkup(await StudioBlogPage({ searchParams: Promise.resolve({ edit: value.id }) }));
  assert.match(html, /Posts couldn&#x27;t be loaded\. Reload to try again\./);
  assert.doesNotMatch(html, /Posts \(0\)|No posts yet/);
  assert.match(html, /data-synthetic-editor="true" data-post-id="0000000001" data-post-title="Fictional bread guide" data-post-body="Complete fictional words\."/);
});

test("an unread list never enables an editor for an independently unread existing post", async () => {
  configure(await fixture, value, "both");
  const html = renderToStaticMarkup(await StudioBlogPage({ searchParams: Promise.resolve({ edit: value.id }) }));
  assert.match(html, /Posts couldn&#x27;t be loaded\. Reload to try again\./);
  assert.match(html, /This post couldn&#x27;t be loaded\. Reload to try again\./);
  assert.match(html, /aria-label="Blog editor unavailable"/);
  assert.doesNotMatch(html, /data-synthetic-editor|Posts \(0\)|No posts yet/);
});

test("the actual blog index keeps unknown, confirmed empty and past-end readings distinct", async () => {
  const shop = await fixture;
  const index = { params: Promise.resolve({ handle: "@blogpageproof" }) };
  // A cached zero must never override the exact nonempty listing.
  configure({ ...shop, posts: 0 }, value, "none");
  assert.match(renderToStaticMarkup(await BlogPage(index)), /Fictional bread guide/);

  configure({ ...shop, posts: 1 }, value, "empty");
  await assert.rejects(() => BlogPage(index), /SYNTHETIC_NOT_FOUND/);

  configure(shop, value, "list");
  const unavailable = renderToStaticMarkup(await BlogPage(index));
  assert.match(unavailable, /role="status"/);
  assert.match(unavailable, /This does not mean there are no posts/);
  assert.doesNotMatch(unavailable, /data-empty-state|Fictional bread guide/);

  configure(shop, value, "past");
  const past = renderToStaticMarkup(await BlogPage({
    ...index, searchParams: Promise.resolve({ page: "2" }),
  }));
  assert.match(past, /data-empty-state=""/);
  assert.match(past, /href="\/@blogpageproof\/blog"/);
  assert.doesNotMatch(past, /This does not mean there are no posts/);
});

test("the actual unavailable index centers its full-height retry link in every buyer language", async () => {
  const shop = await fixture;
  for (const language of ["en", "es", "fr", "de", "it", "nl", "pt"] as const) {
    configure({ ...shop, language }, value, "list");
    const html = renderToStaticMarkup(await BlogPage({
      params: Promise.resolve({ handle: "@blogpageproof" }),
    }));
    const retry = html.match(/<a\b[^>]*href="\/@blogpageproof\/blog"[^>]*>/)?.[0];
    assert.ok(retry, language);
    assert.match(retry, /\bmin-h-11\b/);
    assert.match(retry, /\binline-flex\b/);
    assert.match(retry, /\bitems-center\b/);
    assert.match(retry, /\bjustify-center\b/);
    assert.match(html, /role="status"/);
  }
});
