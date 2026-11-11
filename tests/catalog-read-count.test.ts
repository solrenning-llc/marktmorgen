/**
 * lib/catalog-read-count.ts counts, from the store record alone, how many
 * listings lib/catalog.ts readListings reads from the database: held here to
 * what readListings really asks the database for, with a head, without one,
 * inline, with no catalog, and with ids the store does not have or asked
 * twice. Synthetic stores only.
 */
import { readListings } from "@/lib/catalog";
import { listingsToRead } from "@/lib/catalog-read-count";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let commands: (string | number)[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands.push(...batch);
  return pipeline(batch);
}) as typeof redis.pipeline;

const ids = ["p000000001", "p000000002", "p000000003", "p000000004", "p000000005"];
const listing = (id: string) => ({ id, title: `Synthetic ${id}`, summary: "", priceCents: 1000, createdAt: 0 });
const storeOf = (catalog: { id: string | null; head: string[]; inline: boolean }): Store =>
  ({
    catalog: {
      id: catalog.id,
      items: ids.map((id) => ({ id, kind: 0, options: [] })),
      head: catalog.head.map(listing),
      inline: catalog.inline ? ids.map(listing) : null,
    },
  }) as unknown as Store;

/** The listings readListings asked the database for. */
async function readCount(store: Store, asked?: string[]): Promise<number> {
  commands = [];
  await readListings(store, asked);
  return commands.filter((c) => c[0] === "GET" && /^nl:catalog:.*:l:/.test(String(c[1]))).length;
}

async function main(): Promise<void> {
  redis.clear();
  for (const id of ids) await redis.pipeline([["SET", `nl:catalog:cat-sync:l:${id}`, JSON.stringify(listing(id))]]);
  const stores: [string, Store][] = [
    ["with a head", storeOf({ id: "cat-sync", head: ids.slice(0, 2), inline: false })],
    ["without a head", storeOf({ id: "cat-sync", head: [], inline: false })],
    ["inline", storeOf({ id: "cat-sync", head: [], inline: true })],
    ["with no catalog to read from", storeOf({ id: null, head: [], inline: false })],
  ];
  const asks: [string, string[] | undefined][] = [
    ["every product", undefined],
    ["some, in another order", [ids[4], ids[0], ids[3]]],
    ["ids the store does not have", ["nope000001", ids[2], "nope000002"]],
    ["ids asked twice", [ids[3], ids[3], ids[1], ids[3], ids[1]]],
    ["nothing", []],
  ];
  const expected: Record<string, number[]> = {
    "with a head": [3, 2, 1, 1, 0],
    "without a head": [5, 3, 1, 2, 0],
    "inline": [0, 0, 0, 0, 0],
    "with no catalog to read from": [0, 0, 0, 0, 0],
  };
  for (const [name, store] of stores) {
    part(`A store ${name}`);
    for (const [index, [what, asked]] of asks.entries()) {
      const want = expected[name][index];
      is(`${what}: cost estimator matches the independent count`, listingsToRead(store, asked), want);
      is(`${what}: real database reads match the independent count`, await readCount(store, asked), want);
    }
  }
  is("the head is not read again", listingsToRead(stores[0][1]), ids.length - 2);
  is("an inline store reads none", listingsToRead(stores[2][1]), 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
