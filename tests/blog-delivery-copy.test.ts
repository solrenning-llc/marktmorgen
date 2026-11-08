import assert from "node:assert/strict";
import test from "node:test";
import { postBySlug, type BlogBlock } from "@/lib/blog";

function blockText(block: BlogBlock): string {
  if ("text" in block) return block.text;
  if (block.type === "ul") return block.items.join(" ");
  if (block.type === "steps") return block.items.map(item => `${item.title} ${item.text}`).join(" ");
  return block.items.map(item => item.label).join(" ");
}

test("the published file guide explains delivery states without a fixed-second promise", () => {
  const post = postBySlug("sell-a-digital-file-from-your-bio");
  assert.ok(post);
  assert.doesNotMatch(post.excerpt, /the second someone pays/i);
  const heading = post.body.findIndex(block => block.type === "h2" && /^5\./.test(block.text));
  assert.ok(heading >= 0);
  assert.equal(blockText(post.body[heading]), "5. Make delivery clear");
  const delivery = blockText(post.body[heading + 1]);
  assert.match(delivery, /payment still processing, a confirmed purchase and an expired download link/);
  assert.doesNotMatch(delivery, /appears immediately|within a second|in the same second/i);
});

test("the Stan comparison describes payment-checked access without promising a delivery time", () => {
  const post = postBySlug("how-marktmorgen-compares-with-stan");
  assert.ok(post);
  const heading = post.body.findIndex(block => block.type === "h2" && block.text === "What Marktmorgen is");
  assert.ok(heading >= 0);
  const description = blockText(post.body[heading + 1]);
  assert.match(description, /download access checked against the buyer's payment/);
  assert.doesNotMatch(description, /the second|the moment|instant|immediate/i);
});

test("the file-guide rehearsal uses test mode instead of asking for a real payment", () => {
  const post = postBySlug("sell-a-digital-file-from-your-bio");
  assert.ok(post);
  const notes = post.body.filter(block => block.type === "note").map(blockText).join(" ");
  assert.match(notes, /test mode with a test card/);
  assert.match(notes, /Do not use a real payment as a test/);
  assert.doesNotMatch(notes, /with a real card|Buy your own product/i);
});
