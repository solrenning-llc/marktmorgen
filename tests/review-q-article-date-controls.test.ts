import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArticleData } from "@/components/structured-data";
import { BLOG_POSTS } from "@/lib/blog";

function render(post: (typeof BLOG_POSTS)[number]) {
  const html = renderToStaticMarkup(createElement(ArticleData, { post }));
  return { html, documents: [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]) as Record<string, unknown>) };
}

test("an extra runtime timestamp cannot silently become modification evidence", () => {
  const post = { ...BLOG_POSTS[0], date: "2026-11-05", modifiedAt: "2026-11-06" };
  const article = render(post).documents[0];
  assert.equal(article.datePublished, post.date);
  assert.equal(Object.hasOwn(article, "dateModified"), false);
  assert.equal(Object.hasOwn(article, "modifiedAt"), false);
});

test("the date correction retains safe script encoding and exact article text", () => {
  const post = { ...BLOG_POSTS[0], title: "</script><script>example()</script>", faq: undefined };
  const { html, documents } = render(post);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  assert.equal(documents[0].headline, post.title);
  assert.equal(documents[0].datePublished, post.date);
});

test("article and FAQ remain separate documents with their own unchanged facts", () => {
  const faq = [{ q: "A synthetic question?", a: "A synthetic answer." }];
  const post = { ...BLOG_POSTS[0], faq };
  const { documents } = render(post);
  assert.deepEqual(documents.map(x => x["@type"]), ["BlogPosting", "FAQPage"]);
  assert.deepEqual(documents[1].mainEntity, [{ "@type": "Question", name: faq[0].q, acceptedAnswer: { "@type": "Answer", text: faq[0].a } }]);
});
