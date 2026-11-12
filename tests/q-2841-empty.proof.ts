/** Independent #2841 page proof. Auth, editor and unrelated services are explicit synthetic boundaries. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BlogPage from "../app/studio/blog/page";
import ReviewsPage from "../app/studio/reviews/page";
import { summaries as persistedSummaries } from "../lib/reviews";
import { store as memory } from "./redis-stub";

const sid = "a".repeat(32);
const shop = { statsId: sid, sid, handle: "fictionalproof", name: "Fictional proof store", reviewAsk: { days: 0 }, catalog: { head: [] }, look: {}, language: "en", posts: 0 };
let role = "owner", listUnknown = false, blogUnknown = false, postUnknown = false, total = 0;
export async function cookies() { return {}; }
export function redirect(): never { throw new Error("Synthetic redirect"); }
export async function studioView() { return { ok: true, view: { store: shop, role, stores: [shop], owned: [] } }; }
export function studioPath(_store: unknown, query = "", page = "") { return `/studio/${page}${query ? `?${query}` : ""}`; }
export const productIds = () => ["lesson"];
export const readListings = async (_store: unknown, ids: string[]) => ids.includes("lesson") ? [{ id: "lesson", title: "Fictional lesson" }] : [];
export async function studioReviews() { if (listUnknown) throw new Error("Synthetic list unknown"); return { rows: [], total, unseen: 0 }; }
export const summaries = persistedSummaries;
export const reviewsSince = async () => null;
export const averageText = () => "5.0";
export const showsRating = () => true;
export const HIDDEN_RULE = "Synthetic hiding rule.";
export const OVERVIEW_READ_MAX = 500;
export const readVoice = async () => null;
export const canRecover = () => false;
export const storeBase = () => "https://example.test";
export const canWrite = () => false;
export const aiAvailableFor = () => false;
export const aiLeft = async () => { throw new Error("Unexpected AI read"); };
export const readReviewSummaries = async () => new Map();
export const allPosts = async () => { if (blogUnknown) throw new Error("Synthetic blog unknown"); return []; };
export const readPost = async () => { if (postUnknown) throw new Error("Synthetic post unknown"); return null; };
export const postSegment = () => "fictional-post";
export const StudioHeader = () => null;
export function StudioStorePin({ children }: { children: ReactNode }) { return children; }
export function AiOn({ children }: { children: ReactNode }) { return children; }
export function BlogEditor({ post }: { post: { id: string | null } }) { return createElement("div", { "data-proof-editor": post.id ?? "new" }); }
export const ReviewAskEditor = () => null;
export const ReviewRow = () => null;
export const SeenAllButton = () => null;
export const ReviewQr = () => null;
export const ReviewThemes = () => null;
export const ReviewAiSummaries = () => null;

const renderBlog = async (query = {}) => renderToStaticMarkup(await BlogPage({ searchParams: Promise.resolve(query) }));
const renderReviews = async (query = {}) => renderToStaticMarkup(await ReviewsPage({ searchParams: Promise.resolve(query) }));
const originalPipeline = memory.pipeline.bind(memory);
function reset() { memory.clear(); memory.pipeline = originalPipeline; role = "owner"; listUnknown = blogUnknown = postUnknown = false; total = 0; }

test("empty blog has the h1/h2/h3 outline; each of its three creation links reaches the new editor", async () => {
  reset(); const html = await renderBlog();
  assert.match(html, /<h1[^>]*>Posts on your store/);
  assert.match(html, /<h2[^>]*id="posts-title"[^>]*>Posts \(0\)<\/h2>/);
  assert.match(html, /<h3[^>]*>No posts yet<\/h3>/);
  const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(New post|Write your first post)<\/a>/g)];
  assert.equal(links.length, 3);
  for (const link of links) { const url = new URL(link[1].replaceAll("&amp;", "&"), "https://example.test"); assert.equal(url.pathname, "/studio/blog"); const next = await renderBlog(Object.fromEntries(url.searchParams)); assert.match(next, /data-proof-editor="new"/); assert.doesNotMatch(next, />Write your first post<\/a>/); }
});
test("unread blog list and unread existing post stay unavailable, never confirmed empty or a new editor", async () => {
  reset(); blogUnknown = postUnknown = true;
  const html = await renderBlog({ edit: "missing" });
  assert.match(html, /Posts couldn&#x27;t be loaded/); assert.match(html, /This post couldn&#x27;t be loaded/);
  assert.doesNotMatch(html, /Posts \(0\)|No posts yet|data-proof-editor/);
});
test("reviews preserve zero, queue, off-page and unknown list states; owner jump reaches a focusable heading", async () => {
  reset(); let html = await renderReviews();
  assert.match(html, /<h3[^>]*>Nothing new<\/h3>/);
  assert.match(html, /<a href="#asking-for-reviews"[^>]*>Ask buyers for a review<\/a>/);
  assert.match(html, /<h2 id="asking-for-reviews" tabindex="-1"/);
  // Rule 23 (Claude 5, fixing this review): with no known totals the box keeps main's sentence, never "No product totals yet".
  assert.match(html, /No product review totals are available in this view\./);
  html = await renderReviews({ view: "all" }); assert.match(html, /<h3[^>]*>No reviews yet<\/h3>/);
  role = "support"; html = await renderReviews(); assert.doesNotMatch(html, />Ask buyers for a review<\/a>/);
  role = "owner"; total = 1; html = await renderReviews(); assert.match(html, /No reviews on this page/); assert.doesNotMatch(html, />Ask buyers for a review<\/a>/);
  listUnknown = true; html = await renderReviews(); assert.match(html, /Reviews could not be verified/); assert.doesNotMatch(html, /<h3[^>]*>(Nothing new|No reviews yet|No reviews on this page)<\/h3>/);
});
test("real saved product totals control", async () => {
  reset(); await originalPipeline([["HSET", `nl:rev:sum:${sid}`, "lesson", JSON.stringify({ count: 5, stars: 25, visible: 5, hidden: 0, refunded: 0, dist: [0, 0, 0, 0, 5] })]]);
  const html = await renderReviews(); assert.match(html, /Fictional lesson/); assert.match(html, /5 counted/); assert.doesNotMatch(html, /No product totals yet|>Ask buyers for a review<\/a>/);
});
if (process.env.Q2841_BROWSER === "1") test("Chromium follows the actual rendered reviews anchor and focuses its heading", async () => {
  reset(); const html = await renderReviews();
  const { chromium } = createRequire(`${process.cwd()}/package.json`)("playwright-core");
  const browser = await chromium.launch({ executablePath: "/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage(); await page.setContent(html);
    await page.getByRole("link", { name: "Ask buyers for a review", exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "asking-for-reviews");
  } finally { await browser.close(); }
});
for (const [label, envelope] of [["missing result", []], ["null result", [null]], ["object result", [{}]], ["text result", ["unknown"]], ["truncated pair", [["lesson"]]], ["invalid summary", [["lesson", "broken"]]]] as const) {
  test(`unknown real summaries (${label}) must not claim no product totals yet`, async () => {
    reset();
    await originalPipeline([["HSET", `nl:rev:sum:${sid}`, "lesson", JSON.stringify({ count: 5, stars: 25, visible: 5, hidden: 0, refunded: 0, dist: [0, 0, 0, 0, 5] })]]);
    memory.pipeline = async (commands) => commands[0]?.[0] === "HGETALL" && commands[0]?.[1] === `nl:rev:sum:${sid}` ? envelope as never : originalPipeline(commands);
    const html = await renderReviews();
    assert.equal(html.includes("No product totals yet"), false, "An unknown totals response must not replace known reviews with an assertion of absence");
  });
}
