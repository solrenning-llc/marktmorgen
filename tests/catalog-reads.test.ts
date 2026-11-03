/**
 * How many Redis commands it costs to draw a page.
 *
 * Upstash bills by the command, not by the round trip. So a screen that reads
 * every product in the store to build a list of names costs one command per
 * product, every time it is opened — and a creator at the 2,000-product
 * ceiling was spending two thousand commands to open the email page. Per view.
 * Per creator. With no ceiling of its own.
 *
 * That is the cost-without-a-limit this product is built not to have, and it
 * was not hypothetical: nine call sites did it, across the studio and the
 * public API, and the comment above one of them already said "thousand records
 * to answer one price change" — somebody had seen it and not had a way out.
 *
 * The way out was that the store's own index already answers nearly all of it.
 * It carries, for every product, what kind of thing it is — paid or free, a
 * call, a course, a membership, limited, hidden, has a funnel, is a bundle —
 * and the ids of its price options, all inside the store record that every
 * page reads anyway. What it did not carry was the name, the price and
 * whether the product has a sales page, which is what the lists actually want.
 * Those three now live in one hash: HSET beside the product under the lock the
 * store already holds, one HGETALL to read all of them.
 *
 * These hold the shape, because the easy thing to write is the expensive one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUMP_CHOICES, STUDIO_PAGE_SIZE } from "@/lib/catalog";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir))) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const rel = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), rel)).isDirectory()) out.push(...walk(rel));
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("no page draws itself by reading every product in the store", () => {
  // One exception, and it has to stay one: see the test below it. (And the
  // daily job for a store whose plan ended, lib/plan-closing.ts, which takes
  // the file off every product a store has, once, and is not a page; and the
  // one-time count of what stores keep, lib/data-recount.ts, which reads each
  // store's products once for the ids its keys are named by.)
  // The closing of a store (once, from a job) and its whole export (counted from the studio figure by its size) read every product by design.
  const allowed = new Set(["lib/catalog.ts", "app/api/store/product/route.ts", "lib/imports.ts", "lib/plan-closing.ts", "lib/data-recount.ts", "lib/closed-store-data.ts", "lib/store-export.ts"]);
  const offenders = walk("app")
    .concat(walk("lib"), walk("components"))
    .filter((file) => !allowed.has(file))
    .filter((file) => /readAllListings\s*\(/.test(read(file)));
  assert.deepEqual(
    offenders,
    [],
    "reading the whole catalogue costs one Redis command per product, every time the page opens. " +
      "The name, the price and whether it has a sales page are one command (readCards); everything " +
      "else about a product's kind is already in the store's own index (idsOfKind).",
  );
});

test("the one route that still reads everything says why, and it is not a page", () => {
  // Working out what a change silenced needs every product that could refer to
  // the changed one, and "has a bump" and "has a payment plan" are not in the
  // index. Narrowing it would mean sometimes failing to tell a creator their
  // change turned something off — correctness traded for a cost that is not
  // there, because this runs when a product is saved, not when a page opens.
  const src = read("app/api/store/product/route.ts");
  assert.match(src, /still reads the catalogue, and deliberately/, "a deliberate exception has to say so");
  assert.match(src, /when a product is saved/, "and say why its cost profile is different from a page's");
});

test("the hash is kept in step with the product, on both edges", () => {
  const src = read("lib/catalog.ts");
  const writes = src.slice(src.indexOf("export function productWrites"), src.indexOf("export function productDrops"));
  assert.match(writes, /\["HSET", titlesKey\(catalog\), product\.id, cardValue\(product\)\]/, "saved with the product");
  const drops = src.slice(src.indexOf("export function productDrops"), src.indexOf("export function productDrops") + 400);
  assert.match(drops, /\["HDEL", titlesKey\(catalog\), id\]/, "and removed with it — a cache that only grows is a wrong cache");
});

test("the card carries exactly what the index cannot answer, and nothing more", () => {
  // Every field added here is paid for by every product in the store, so the
  // test is as much about what is NOT in it. Kind, options, hidden, limited,
  // course, call, membership and funnel are all already in the index.
  const src = read("lib/catalog.ts");
  const at = src.indexOf("export type Card =");
  assert.ok(at > 0, "the card type should exist");
  const line = src.slice(at, src.indexOf("\n", at));
  assert.match(line, /title: string/);
  assert.match(line, /priceCents: number/);
  assert.match(line, /page: boolean/);
  for (const field of ["course", "call", "recurring", "hidden", "stock", "options", "file", "image"]) {
    assert.ok(!new RegExp(`\\b${field}\\b`).test(line), `${field} is in the index already; putting it on the card pays for it twice`);
  }
});

test("a store written before the hash heals itself instead of staying slow", () => {
  const src = read("lib/catalog.ts");
  const at = src.indexOf("export async function readCards");
  const body = src.slice(at, src.indexOf("export async function readTitles"));
  assert.match(body, /if \(found\.size >= ids\.length\) return found;/, "a complete hash is the fast path");
  assert.match(body, /readListings\(store, ids\.filter/, "and an incomplete one pays the old cost once");
  assert.match(body, /"HSET",\s*titlesKey/, "leaving the hash right for every read after it");
  assert.match(body, /\.catch\(/, "best-effort: a cache that cannot be filled must not break the page");
});

test("an entry for a product that no longer exists is never handed back", () => {
  const src = read("lib/catalog.ts");
  const at = src.indexOf("export async function readCards");
  const body = src.slice(at, src.indexOf("export async function readTitles"));
  assert.match(body, /const known = new Set\(ids\);/, "the index decides what exists, not the cache");
});

test("a store on the old inline layout costs no read at all", () => {
  const src = read("lib/catalog.ts");
  const at = src.indexOf("export async function readCards");
  const body = src.slice(at, at + 600);
  assert.match(body, /if \(catalog\.inline\) return new Map/, "its products are already in the record the page just read");
});

test("every picker that cannot be answered from the index is bounded", () => {
  // These three want things no index carries — whether a product has a file,
  // an image, or a price the buyer names. They narrow with the index first and
  // then read a capped number, so the cost does not follow the catalogue.
  assert.ok(BUMP_CHOICES >= 100, "a cap below this would be reachable by a real store");
  assert.ok(BUMP_CHOICES <= 1_000, "a cap this high stops bounding anything worth bounding");
  assert.ok(BUMP_CHOICES > STUDIO_PAGE_SIZE * 4, "and it has to be comfortably past what one page shows");

  // The bundle picker reads through lib/bundle-choices.ts, shared by its route and the MCP tool list_bundle_choices.
  for (const file of ["lib/catalog.ts", "app/studio/funnels/page.tsx", "lib/bundle-choices.ts"]) {
    const src = read(file);
    assert.match(src, /BUMP_CHOICES/, `${file} builds a picker and has to cap what it reads`);
    assert.match(src, /idsOfKind\(store, "(recurring|call|free)"\)/, `${file} should rule out with the index before reading`);
  }
});

test("the search in the studio is a question about names, so it costs one command", () => {
  const src = read("lib/catalog.ts");
  const at = src.indexOf("const titles = await readCards(store)") + 1 || src.indexOf("const titles = await readTitles(store)");
  assert.ok(src.includes("readTitles(store)") || src.includes("readCards(store)"), "the list reads names, not products");
  const paging = src.slice(src.indexOf("const needle = query.toLowerCase();"), src.indexOf("const needle = query.toLowerCase();") + 700);
  assert.match(paging, /readProducts\(store, matches\.slice\(from, from \+ STUDIO_PAGE_SIZE\)\)/, "and reads only the page it shows");
  void at;
});
