/**
 * Issue #4304, unit E (coordinator, 13/11/2026): the course page's "More from" shelf no longer reads the card of
 * every product (one HGETALL, up to MAX_PRODUCTS cards, past the page's 200 KB) and never heals an old store's
 * cards from its listings on a load (one listing can hold MAX_PRODUCT_BYTES, more than the page's whole figure).
 * The lessons tab names the six chosen; a Shelf tab offers the store's products SHELF_PAGE at a time, in the
 * creator's order, by one HMGET of those cards; a product whose card is not there is said as such, never named
 * from a guess.
 *
 * Against a Redis that answers every command at its largest, and the source.
 */
import { readFileSync } from "node:fs";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { SHELF_PAGE, shelfTab } from "@/lib/studio-course-tabs";
import { MAX_PRODUCTS, MAX_TITLE_LENGTH } from "@/lib/catalog-rules";
import type { Course } from "@/lib/course";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);
const COMMANDS = STUDIO_PAGE_UNITS * 20 - 8;
const BYTES = STUDIO_PAGE_UNITS * 50_000;
const WIDE = "\u{10FFFF}";
const ids = Array.from({ length: MAX_PRODUCTS }, (_, i) => `p${String(i).padStart(9, "0")}`);
const store = { catalog: { id: "c".repeat(24), items: ids.map((id) => ({ id, kind: 0 })), head: [], inline: null } } as unknown as Store;
const course = { id: "d".repeat(32), shelf: ids.slice(-6) } as unknown as Course;

async function main(): Promise<void> {
  part("A page of the Shelf tab, at its worst");
  for (const [what, answer] of [
    ["every card there, at its longest", (n: number) => Array.from({ length: n }, () => JSON.stringify([WIDE.repeat(MAX_TITLE_LENGTH), 99_999_999, 1]))],
    ["no card there (an old store)", (n: number) => Array.from({ length: n }, () => null)],
  ] as const) {
    let commands = 0;
    let bytes = 0;
    redis.pipeline = async (batch: Commands) => {
      commands += batch.length;
      const replies = batch.map((c) => (c[0] === "HMGET" ? answer(c.length - 2) : c[0] === "GET" ? null : null));
      bytes += Buffer.byteLength(JSON.stringify(replies));
      return replies;
    };
    const read = await shelfTab(store, course, "p000000000", 999).catch((error) => error);
    redis.pipeline = realPipeline;
    console.log(`  ${what}: ${commands} commands, ${bytes} bytes`);
    is(`${what}: within ${COMMANDS} commands and ${BYTES} bytes`, commands <= COMMANDS && bytes <= BYTES, true);
    is(`${what}: no listing read to heal a card`, commands <= 1, true);
    if (what.startsWith("no card")) is("the products without a card are said as such", (read as { unnamed?: number })?.unnamed, SHELF_PAGE);
  }

  part("The lessons tab names the six chosen, never every product's card");
  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  is("no readTitles on the course page", page.includes("readTitles("), false);
  is("a Shelf tab", page.includes('["shelf", "Shelf"]'), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
