import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NextRequest } from "next/server";
import { GET } from "@/app/api/store/stats/range/route";
import { readMarks } from "@/lib/auto-marks";
import { CustomRangeResults } from "@/components/custom-range";
import type { Store } from "@/lib/store";
import type { RangeData } from "@/lib/stats";
import { store as redis } from "./redis-stub";
import { world } from "./stats-range-titles-unknown-world";

/**
 * VR2 audit (MÉDIO): when the product names or the marks of the chosen days
 * could not be read, the stats said every product was gone from the store and
 * that nothing was marked. Unknown is never absence (rule 24): a product the
 * store's own index lists is never called gone, and marks that could not be
 * read are said to be unavailable, not shown as none.
 */
const catalogId = "synthetic-stats-range-catalog";
const store = {
  handle: "synthetic-range",
  listId: "synthetic-range-list",
  catalog: { id: catalogId, items: [{ id: "kept", kind: 1, options: [] }, { id: "unnamed", kind: 1, options: [] }], head: [], inline: null },
  pastSales: [],
  sale: { name: "", percent: 0, starts: 0, ends: 0 },
} as unknown as Store;
const range: RangeData = {
  from: "2026-03-01", to: "2026-03-03", currency: "usd", sales: "ok", partial: false, elsewhere: 0, days: [], channels: [],
  products: [
    { id: "kept", views: 5, checkouts: 1, sales: 1, cents: 500 },
    { id: "unnamed", views: 2, checkouts: 0, sales: 0, cents: 0 },
    { id: "removed", views: 1, checkouts: 0, sales: 0, cents: 0 },
  ],
  totals: { visitors: 4, views: 8, checkouts: 1, sales: 1, cents: 500 }, before: null,
};
world.store = store;
world.range = range;
const GONE = "A product no longer in your store";
const UNKNOWN = "Title could not be loaded";
const request = { nextUrl: new URL("https://local.example/api/store/stats/range?from=2026-03-01&to=2026-03-03") } as unknown as NextRequest;
type Body = { ok: boolean; range: { products: { id: string; title: string }[] }; marks: unknown; titlesUnavailable?: boolean };
const answer = async () => (await (await GET(request)).json()) as Body;
const titleOf = (body: Body, id: string) => body.range.products.find((p) => p.id === id)?.title;
const failing = async <T>(run: () => Promise<T>) => {
  const original = redis.pipeline;
  redis.pipeline = async () => { throw new Error("synthetic Redis failure"); };
  try { return await run(); } finally { redis.pipeline = original; }
};

redis.clear();
const seeded = redis.pipeline([["HSET", `nl:catalog:${catalogId}:t`, "kept", JSON.stringify(["Fictional bread guide", 500, 1]), "unnamed", JSON.stringify(["Fictional starter kit", 900, 1])]]);

test("healthy control: names are read, a product the index no longer lists is gone, no marks is a real empty list", async () => {
  await seeded;
  const body = await answer();
  assert.equal(body.ok, true);
  assert.equal(titleOf(body, "kept"), "Fictional bread guide");
  assert.equal(titleOf(body, "unnamed"), "Fictional starter kit");
  assert.equal(titleOf(body, "removed"), GONE);
  assert.deepEqual(body.marks, []);
  assert.notEqual(body.titlesUnavailable, true);
});

test("names that could not be read never call a listed product gone", async () => {
  await seeded;
  const body = await failing(answer);
  assert.equal(body.ok, true);
  assert.equal(titleOf(body, "kept"), UNKNOWN);
  assert.equal(titleOf(body, "unnamed"), UNKNOWN);
  assert.equal(titleOf(body, "removed"), GONE, "the store's own index says this one is gone, read or not");
  assert.equal(body.titlesUnavailable, true);
});

test("marks that could not be read are unavailable, never an empty list", async () => {
  await seeded;
  const body = await failing(answer);
  assert.equal(body.marks, null);
});

test("readMarks rejects when its reads fail instead of answering no marks", async () => {
  await seeded;
  await failing(() => assert.rejects(() => readMarks(store, "2026-03-01", "2026-03-03")));
});

test("readMarks confirmed absence stays an empty list", async () => {
  await seeded;
  assert.deepEqual(await readMarks(store, "2026-03-01", "2026-03-03"), []);
});

test("a listed product whose name is missing is unknown, not gone", async () => {
  await seeded;
  await redis.pipeline([["HDEL", `nl:catalog:${catalogId}:t`, "unnamed"]]);
  try {
    const body = await answer();
    assert.equal(titleOf(body, "kept"), "Fictional bread guide");
    assert.equal(titleOf(body, "unnamed"), UNKNOWN);
    assert.equal(titleOf(body, "removed"), GONE);
    assert.equal(body.titlesUnavailable, true);
  } finally {
    await redis.pipeline([["HSET", `nl:catalog:${catalogId}:t`, "unnamed", JSON.stringify(["Fictional starter kit", 900, 1])]]);
  }
});

const products = range.products.map((p) => ({ ...p, title: p.id === "removed" ? GONE : UNKNOWN }));
const named = range.products.map((p) => ({ ...p, title: p.id === "removed" ? GONE : "Fictional bread guide" }));
const render = (props: Record<string, unknown>, rows = products) => renderToStaticMarkup(createElement(CustomRangeResults as never, { range: { ...range, products: rows }, currency: "usd", ...props }));

test("the page says the marks could not be loaded, in a status region", () => {
  const html = render({ marks: null, titlesUnavailable: false });
  assert.match(html, /<p[^>]*role="status"[^>]*>[^<]*could not be loaded[^<]*<\/p>/);
  assert.ok(html.includes("Marks for these days could not be loaded."));
});

test("the page explains product names that could not be loaded", () => {
  const html = render({ marks: [], titlesUnavailable: true });
  assert.ok(html.includes("Some product names could not be loaded."));
  assert.ok(!html.includes("Marks for these days could not be loaded."));
});

test("healthy page control: no unavailable notes", () => {
  const html = render({ marks: [], titlesUnavailable: false }, named);
  assert.ok(!html.includes("could not be loaded"));
});
