/**
 * VR 2, rule 24: the unsubscribe page for a product's update emails never calls a link unknown when it could not be
 * read (lib/product-updates.ts readUpdateStop; app/unsubscribe/page.tsx StopUpdates).
 *
 * Before: a GET of the stop link answered cut short or of another shape, or its EXISTS, made readUpdateStop answer
 * null, and the page said "This link is not one we know". Now readUpdateStop throws on an unknown read and the page
 * says it could not open the link just now (linkNotReadTitle), as it already does for a community's link. A link
 * confirmed absent is still unknown; a known link still offers its button.
 *
 * Synthetic token and address only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { readUpdateStop } from "@/lib/product-updates";
import UnsubscribePage from "@/app/unsubscribe/page";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { store as redis } from "./redis-stub";

const TOKEN = "b".repeat(40);
const GRANT = JSON.stringify({ s: "c".repeat(32), e: "buyer@example.com", h: "", n: "Shop" });
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const words = affiliatesWords(undefined);

async function page(): Promise<string> {
  const outer = (await UnsubscribePage({ searchParams: Promise.resolve({ u: TOKEN }) } as never)) as ReactElement;
  const render = outer.type as (props: unknown) => Promise<ReactElement>;
  return renderToStaticMarkup(await render(outer.props));
}

for (const [label, match, reply] of [
  ["the link's GET cut short", (b: Batch) => b[0][0] === "GET", []],
  ["the link's GET as a number", (b: Batch) => b[0][0] === "GET", [7]],
  ["its EXISTS cut short", (b: Batch) => b[0][0] === "EXISTS", []],
] as [string, (b: Batch) => boolean, unknown[]][]) {
  test(`${label}: unknown, never "not one we know"`, async () => {
    redis.clear();
    await pipeline([["SET", `nl:upd:stop:${TOKEN}`, GRANT]]);
    redis.pipeline = (async (b: Batch) => (b.length === 1 && match(b) ? reply : pipeline(b))) as typeof redis.pipeline;
    try {
      await assert.rejects(readUpdateStop(TOKEN));
      const html = await page();
      assert.ok(html.includes(words.linkNotReadTitle), "says it could not open the link just now");
      assert.ok(!html.includes(words.unknownLink));
    } finally {
      redis.pipeline = pipeline;
    }
  });
}

test("a link confirmed absent is still unknown", async () => {
  redis.clear();
  assert.equal(await readUpdateStop(TOKEN), null);
  const html = await page();
  assert.ok(html.includes(words.unknownLink));
});

async function pageWith(query: Record<string, string>): Promise<string> {
  const outer = (await UnsubscribePage({ searchParams: Promise.resolve(query) } as never)) as ReactElement;
  const render = outer.type as (props: unknown) => Promise<ReactElement>;
  return renderToStaticMarkup(await render(outer.props));
}

test("a press the route could not save (done=0) is said in a status message, and the button is offered again", async () => {
  redis.clear();
  await pipeline([["SET", `nl:upd:stop:${TOKEN}`, GRANT]]);
  const html = await pageWith({ u: TOKEN, done: "0" });
  const status = /<p role="status"[^>]*>([^<]*)<\/p>/.exec(html);
  assert.ok(status, "a role=status message is drawn");
  assert.equal(status[1], words.reviewsNotSaved);
  assert.ok(html.includes('type="submit"'), "the button is still offered");
});

test("without done=0 the status region stays empty", async () => {
  redis.clear();
  await pipeline([["SET", `nl:upd:stop:${TOKEN}`, GRANT]]);
  const html = await pageWith({ u: TOKEN });
  assert.ok(!html.includes(words.reviewsNotSaved));
});
