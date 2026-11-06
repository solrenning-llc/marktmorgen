import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import Page from "../app/studio/reviews/page";
import { configure } from "./review-summary-page-world";
const page = () => Page({ searchParams: Promise.resolve({}) });
test("actual page keeps reviews usable and marks unknown summaries unavailable", async () => {
  configure("unknown");
  const html = renderToStaticMarkup(await page());
  assert.match(html, /What your buyers say/);
  assert.match(html, /asking-for-reviews/);
  assert.match(html, /Review summaries couldn&#x27;t be loaded\. Reload to try again\./);
  assert.doesNotMatch(html, /data-summary-slot|data-week-at="0"/);
});
test("confirmed summary and weekly timestamp reach the existing component unchanged", async () => {
  configure("healthy");
  const html = renderToStaticMarkup(await page());
  assert.match(html, /data-summary-at="1793952000" data-week-at="1793952000"/);
  assert.doesNotMatch(html, /Review summaries couldn/);
});
test("confirmed summary absence remains distinct from unavailable", async () => {
  configure("empty");
  const html = renderToStaticMarkup(await page());
  assert.match(html, /data-summary-at="none" data-week-at="0"/);
  assert.doesNotMatch(html, /Review summaries couldn/);
});
