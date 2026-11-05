import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import PostPage, { generateMetadata, generateStaticParams } from "@/app/blog/[slug]/page";
import sitemap from "@/app/sitemap";
import { BLOG_POSTS, FEATURED_SLUG, postBySlug } from "@/lib/blog";
import { feeWords } from "@/lib/fee-words";
import { PLANS_ON_SALE, PREVIEW_LINE } from "@/lib/opening";
import { findPage } from "@/lib/site-pages";
import { SITE_URL } from "@/lib/site-url";
import { overdue, writtenDates } from "@/lib/competitor-review";

const SLUG = "skool-alternatives-community-platforms";
function guide() {
  const post = postBySlug(SLUG);
  assert.ok(post, "the distinct community-platform decision guide is published in the real journal catalog");
  return post;
}

test("the decision guide uses the existing article route, canonical metadata and dated sitemap", async () => {
  const post = guide();
  assert.equal(post.category, "Comparisons");
  assert.ok(generateStaticParams().some((entry) => entry.slug === SLUG));
  const meta = await generateMetadata({ params: Promise.resolve({ slug: SLUG }) });
  assert.equal(meta.description, post.excerpt);
  assert.equal(meta.alternates?.canonical, `/blog/${SLUG}`);
  const entries = sitemap().filter((entry) => entry.url === `${SITE_URL}/blog/${SLUG}`);
  assert.equal(entries.length, 1);
  assert.equal((entries[0].lastModified as Date).toISOString().slice(0, 10), post.date);
});

test("Marktmorgen's availability and payment description come from the real product", () => {
  const post = guide();
  const text = JSON.stringify(post);
  if (!PLANS_ON_SALE) {
    assert.ok(post.body.some((block) => block.type === "note" && block.text === PREVIEW_LINE));
    assert.ok(post.faq?.some((item) => item.a === PREVIEW_LINE));
  }
  assert.ok(post.body.some((block) => block.type === "p" && block.text === feeWords().whoHolds));
  assert.ok(text.includes("A CSV file does not move payment cards or live billing agreements."));
  assert.doesNotMatch(text, /\$\d|guaranteed income|best platform|move everything|one-click migration/i);
});

test("the guide provides distinct decision work and only links to existing product pages", () => {
  const post = guide();
  const headings = post.body.filter((block) => block.type === "h2").map((block) => block.text);
  for (const subject of ["job", "Circle", "Kajabi", "Marktmorgen", "move"]) {
    assert.ok(headings.some((heading) => heading.toLowerCase().includes(subject.toLowerCase())), subject);
  }
  assert.ok(post.body.some((block) => block.type === "steps" && block.items.length >= 4));
  const links = post.body.filter((block) => block.type === "links").flatMap((block) => block.items);
  for (const { href } of links.filter((link) => /^\/(proof|platform)\//.test(link.href))) {
    const [, section, slug] = href.split("/");
    assert.ok(findPage(section as "proof" | "platform", slug), href);
  }
  assert.ok(links.some((link) => link.href === "/proof/skool"));
  assert.ok(links.some((link) => link.href === "/platform/switching-to-marktmorgen"));
  assert.ok(links.some((link) => link.href === "/pricing"));
  assert.notEqual(post.excerpt, postBySlug("skool-fees-explained")?.excerpt);
});

test("competitor statements have explicit primary sources and a reviewable reading date", () => {
  const post = guide();
  const links = post.body.filter((block) => block.type === "links").flatMap((block) => block.items);
  const external = links.map((link) => link.href).filter((href) => href.startsWith("https://"));
  assert.deepEqual(new Set(external), new Set([
    "https://help.skool.com/article/210-how-to-go-live-on-skool",
    "https://circle.so/pricing",
    "https://www.kajabi.com/pricing",
    "https://www.kajabi.com/features/email-marketing",
  ]));
  const facts = writtenDates(JSON.stringify(post), `/blog/${SLUG}`);
  assert.ok(facts.length > 0);
  assert.ok(facts.every((fact) => fact.readOn === "2026-11-05"));
  assert.deepEqual(overdue(facts), []);
});

test("the actual article renders its copy, sources, FAQ and structured headline without network calls", async () => {
  const post = guide();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("Unexpected request while rendering the guide"); }) as typeof fetch;
  try {
    const html = renderToStaticMarkup(await PostPage({ params: Promise.resolve({ slug: SLUG }) }));
    assert.ok(html.includes(post.title));
    assert.ok(html.includes('href="https://circle.so/pricing"'));
    const documents = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
    const article = documents.find((document) => document["@type"] === "BlogPosting");
    assert.equal(article?.headline, post.title);
    assert.equal(article?.datePublished, post.date);
    const faq = documents.find((document) => document["@type"] === "FAQPage");
    assert.deepEqual(faq.mainEntity.map((item: { name: string }) => item.name), post.faq!.map((item) => item.q));
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.equal(ids.filter((id) => id === target).length, 1, target);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the existing journal and the unknown-slug metadata behavior are preserved", async () => {
  assert.equal(FEATURED_SLUG, "what-selling-on-gumroad-costs");
  assert.ok(postBySlug("skool-fees-explained"));
  assert.ok(postBySlug("kajabi-vs-teachable-vs-marktmorgen"));
  assert.equal(new Set(BLOG_POSTS.map((post) => post.slug)).size, BLOG_POSTS.length);
  assert.deepEqual(await generateMetadata({ params: Promise.resolve({ slug: "not-an-existing-guide" }) }), {});
});
