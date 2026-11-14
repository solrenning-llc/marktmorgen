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

/** The listings readListings asked the database for: the keys of its MGETs (LISTINGS_PER_MGET at one, lib/catalog.ts getMany). */
async function readCount(store: Store, asked?: string[]): Promise<number> {
  commands = [];
  await readListings(store, asked);
  const keys = commands.flatMap((c) => (c[0] === "MGET" ? c.slice(1) : c[0] === "GET" ? [c[1]] : []));
  return keys.filter((key) => /^nl:catalog:.*:l:/.test(String(key))).length;
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
  for (const [name, store] of stores) {
    part(`A store ${name}`);
    for (const [what, asked] of asks) is(`${what}: counted as read`, listingsToRead(store, asked), await readCount(store, asked));
  }
  is("the head is not read again", listingsToRead(stores[0][1]), ids.length - 2);
  is("an inline store reads none", listingsToRead(stores[2][1]), 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
