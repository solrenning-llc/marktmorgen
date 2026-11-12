import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArticleData } from "@/components/structured-data";
import { BLOG_POSTS } from "@/lib/blog";

function article(post: (typeof BLOG_POSTS)[number]): Record<string, unknown> {
  const html = renderToStaticMarkup(createElement(ArticleData, { post }));
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "the real article component emits JSON-LD");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

test("article JSON-LD publishes only the date the blog model can prove", () => {
  for (const post of BLOG_POSTS) {
    const data = article(post);
    assert.equal(data.datePublished, post.date, post.slug);
    assert.equal(Object.hasOwn(data, "dateModified"), false, post.slug);
  }
});
