import assert from "node:assert/strict";
import test from "node:test";
import { COMPETITOR_PRICES } from "@/lib/competitor-prices";
import { REVIEW_DAYS, datedSources, dueNext, overdue, writtenDates } from "@/lib/competitor-review";
import { BLOG_POSTS } from "@/lib/blog";
import { FEATURE_PAGES, CREATOR_PAGES } from "@/lib/feature-pages";
import { FINAL_COMPARISON_PAGES } from "@/lib/final-comparison-pages";
import { findPage, slugsFor } from "@/lib/site-pages";
import { HELP_SECTIONS } from "@/lib/help-content";

/** Every dated fact the public pages and the price table carry. */
function allFacts() {
  const pages = [
    ...BLOG_POSTS.map((post) => ({ where: `/blog/${post.slug}`, text: JSON.stringify(post) })),
    ...FEATURE_PAGES.map((page) => ({ where: `/platform/${page.slug}`, text: JSON.stringify(page) })),
    ...CREATOR_PAGES.map((page) => ({ where: `/for/${page.slug}`, text: JSON.stringify(page) })),
    ...FINAL_COMPARISON_PAGES.map((page) => ({ where: `/${page.section}/${page.slug}`, text: JSON.stringify(page) })),
    ...slugsFor("proof").map(({ slug }) => ({ where: `/proof/${slug}`, text: JSON.stringify(findPage("proof", slug)) })),
    ...HELP_SECTIONS.map((section) => ({ where: `/help#${section.id}`, text: JSON.stringify(section) })),
  ];
  return [...datedSources(COMPETITOR_PRICES, "COMPETITOR_PRICES"), ...pages.flatMap((page) => writtenDates(page.text, page.where))];
}

test("the routine reads both kinds of dated fact", () => {
  assert.deepEqual(writtenDates("article 340, read September 30, 2026; read on October 5, 2026 and checked again on September 28, 2026", "x").map((f) => f.readOn), ["2026-09-30", "2026-10-05", "2026-09-28"]);
  assert.deepEqual(datedSources({ a: { label: "A", url: "https://a.example", readOn: "2026-10-20" }, b: [{ readOn: "2026-10-19" }] }).map((f) => f.readOn), ["2026-10-20", "2026-10-19"]);
  const facts = allFacts();
  assert.ok(facts.length > 50, `only ${facts.length} dated facts found`);
});

test("a fact is due once it is older than the review window, or its date is not a real day", () => {
  const now = Date.parse("2026-12-20T12:00:00Z");
  const due = overdue([{ where: "a", readOn: "2026-09-20" }, { where: "b", readOn: "2026-10-20" }, { where: "c", readOn: "2026-02-30" }], now);
  assert.deepEqual(due.map((f) => f.where), ["c", "a"]);
  assert.equal(REVIEW_DAYS, 90);
});

test(`no competitor fact on a public page or in the price table is more than ${REVIEW_DAYS} days old`, () => {
  const late = overdue(allFacts());
  const next = dueNext(allFacts()).slice(0, 3);
  assert.deepEqual(
    late.slice(0, 20),
    [],
    `read these again on their official pages, update the date, and fix the fact if it changed (next due: ${next.map((n) => `${n.due} for ${n.count} read ${n.readOn}`).join("; ")})`,
  );
});
