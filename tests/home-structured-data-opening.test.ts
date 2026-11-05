import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Faq } from "@/components/home-static";
import { ArticleData, HomeData, JsonLd, SiteData } from "@/components/structured-data";
import { BLOG_POSTS } from "@/lib/blog";
import { homeQuestions } from "@/lib/home-faq";
import { PLANS_ON_SALE, PREVIEW_LINE } from "@/lib/opening";
import { PUBLISHED_PLAN_PRICES, PLAN_TITLES, TIERS, TRIAL_DAYS } from "@/lib/plan";
import { SITE_URL } from "@/lib/site-url";

type Markup = {
  "@type": string;
  "@id"?: string;
  "@graph"?: Markup[];
  description?: string;
  offers?: unknown;
  mainEntity?: unknown;
  headline?: string;
  datePublished?: string;
  dateModified?: string;
};

function documents(html: string): Markup[] {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, "the real component emits JSON-LD");
  return scripts.flatMap((script) => {
    const data = JSON.parse(script[1]) as Markup;
    return data["@graph"] ?? [data];
  });
}

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

const questions = homeQuestions();
const homeMarkup = documents(render(createElement(HomeData, { questions })));
const application = homeMarkup.find((item) => item["@type"] === "SoftwareApplication")!;
assert.ok(application);

test("home offers exist only when a paid plan can actually start", () => {
  if (!PLANS_ON_SALE) {
    assert.equal(Object.hasOwn(application, "offers"), false);
    return;
  }
  assert.deepEqual(application.offers, TIERS.map((tier) => ({
    "@type": "Offer",
    name: `${PLAN_TITLES[tier]}, monthly`,
    price: (PUBLISHED_PLAN_PRICES[tier].month / 100).toFixed(2),
    priceCurrency: "USD",
    url: `${SITE_URL}/#pricing`,
  })));
});

test("home description uses the visible preview message while plans are closed", () => {
  if (!PLANS_ON_SALE) {
    assert.equal(application.description, PREVIEW_LINE);
    assert.doesNotMatch(application.description!, /free trial/i);
  } else {
    assert.ok(application.description?.includes(`${TRIAL_DAYS}-day free trial`));
  }
});

test("the home FAQ rendered for visitors and its markup agree about availability", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("Unexpected network request"); }) as typeof fetch;
  try {
    const html = render(Faq({ questions }));
    if (!PLANS_ON_SALE) {
      assert.match(html, /Plans are not on sale yet, so selling starts the day they open\./);
      assert.ok(application.description?.includes("paid plans are not on sale yet"));
      assert.equal(Object.hasOwn(application, "offers"), false);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("home FAQ preserves every question and answer shown to visitors", () => {
  const faq = homeMarkup.find((item) => item["@type"] === "FAQPage")!;
  assert.deepEqual(faq.mainEntity, questions.map(({ q, a }) => ({
    "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a },
  })));
  assert.equal(homeMarkup.length, 2);
});

test("JSON-LD still escapes script-ending text and round-trips the original text", () => {
  const value = "</script><script>alert('example')</script> < & \u2028 \u2029";
  const html = render(createElement(JsonLd, { data: { "@type": "Thing", description: value } }));
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  assert.equal(documents(html)[0].description, value);
});

test("site identity and article facts remain independently available", () => {
  const site = documents(render(createElement(SiteData)));
  assert.deepEqual(site.map((item) => item["@type"]), ["Organization", "WebSite"]);
  assert.equal(site[0]["@id"], `${SITE_URL}/#organization`);
  assert.equal(site[1]["@id"], `${SITE_URL}/#website`);
  const post = BLOG_POSTS[0];
  const article = documents(render(createElement(ArticleData, { post })))[0];
  assert.equal(article["@type"], "BlogPosting");
  assert.equal(article.headline, post.title);
  assert.equal(article.datePublished, post.date);
  assert.equal(article.dateModified, post.date);
  assert.equal(Object.hasOwn(article, "offers"), false);
});
