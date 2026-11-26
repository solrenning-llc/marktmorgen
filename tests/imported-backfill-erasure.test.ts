/**
 * A purchase brought over by an import before the list of who was brought existed (nl:imp:who) is noted there the
 * first time it is read (lib/imported-purchases.ts noteBrought). That read can begin before the person is deleted
 * (forgetImportedPerson takes their grants, then their note) and write after it: the note must then not come back
 * with their address (#3945, Codex L). The note is written only while the grant is still kept (ORDER_WRITE_IF_KEY,
 * lib/order-data.ts). Controls: a person not deleted is noted once, with the time they were brought; a person
 * already noted keeps their first time. Every store, person and identifier here is a synthetic stand-in.
 */
import { claimHandle, ensureStatsId, setPastBuyers, storeForEmail, type Store } from "@/lib/store";
import { forgetImportedPerson, importedBuyers, importedFor, importedKey, importedRowsFor, importedWhoKey } from "@/lib/imported-purchases";
import { dataKey } from "@/lib/store-data";
import { ORDER_WRITE, ORDER_WRITE_IF_KEY } from "@/lib/order-data";
import { ORDERS_IMPORTED_COMMANDS } from "@/lib/buyer-orders-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "backfill-owner@example.com";
const BUYER = "legacy.buyer@example.com";
const JOB = "a1b2c3d4e5f6a7b8c9d0e1f2";
const BROUGHT_AT = 1_700_000_000;

/** A grant an import wrote before nl:imp:who existed: the purchase only, no note. */
async function legacyGrant(store: Store, email: string): Promise<void> {
  await redis.pipeline([["HSET", importedKey(store.statsId!, email), "p_legacy_guide", JSON.stringify({ at: BROUGHT_AT, job: JOB, items: null })]]);
}

/** Whether a command is the note's own write: the wrapped order script carrying an HSETNX on the buyers brought. */
const isNote = (statsId: string, command: (string | number)[]) =>
  command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:order-write") && command.includes(importedWhoKey(statsId));

/** Runs `during` once, just before the first note write reaches Redis, as a deletion landing between read and write. */
function beforeNote(statsId: string, during: () => Promise<unknown>): () => void {
  const pipeline = redis.pipeline.bind(redis);
  let fired = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!fired && commands.some((command) => isNote(statsId, command))) {
      fired = true;
      await during();
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = pipeline as typeof redis.pipeline;
  };
}

const roomUsed = async (store: Store) => {
  const [raw] = await redis.pipeline([["HGETALL", dataKey(store)!]]);
  return JSON.stringify(raw);
};

async function shop(): Promise<Store> {
  redis.clear();
  const claimed = await claimHandle(OWNER, "backfill-shop", "Backfill shop", "");
  if (!claimed.ok) throw new Error("synthetic store was not made");
  await ensureStatsId(OWNER);
  await setPastBuyers(OWNER);
  return (await storeForEmail(OWNER))!;
}

async function main(): Promise<void> {
  for (const [label, read] of [
    ["importedFor", (store: Store) => importedFor(store, BUYER)],
    ["importedRowsFor", (store: Store) => importedRowsFor(store, BUYER)],
  ] as const) {
    part(`${label}: a person deleted between the read and its note is not noted back`);
    const store = await shop();
    await legacyGrant(store, BUYER);
    const room = await roomUsed(store);
    const restore = beforeNote(store.statsId!, () => forgetImportedPerson(store.statsId, BUYER));
    try {
      await read(store);
    } finally {
      restore();
    }
    is("the grant stays gone", (await redis.pipeline([["EXISTS", importedKey(store.statsId!, BUYER)]]))[0], 0);
    is("their address is not among the buyers brought", (await redis.pipeline([["HGET", importedWhoKey(store.statsId!), BUYER]]))[0], null);
    is("the store's list of buyers brought does not name them", [...(await importedBuyers(store.statsId)).keys()], []);
    is("nothing was charged to the store's room for a note not written", await roomUsed(store), room);
  }

  part("control: a person not deleted is noted once, with the time they were brought");
  {
    const store = await shop();
    await legacyGrant(store, BUYER);
    is("their purchase reads", (await importedFor(store, BUYER)).map((p) => p.productId), ["p_legacy_guide"]);
    is("they are noted among the buyers brought", (await redis.pipeline([["HGET", importedWhoKey(store.statsId!), BUYER]]))[0], String(BROUGHT_AT));
    is("the note was charged to the store's room", (await roomUsed(store)) !== "[]", true);
  }

  part("control: a person already noted keeps their first time");
  {
    const store = await shop();
    await legacyGrant(store, BUYER);
    await redis.pipeline([["HSET", importedWhoKey(store.statsId!), BUYER, "1600000000"]]);
    await importedFor(store, BUYER);
    is("the first time is kept", (await redis.pipeline([["HGET", importedWhoKey(store.statsId!), BUYER]]))[0], "1600000000");
  }

  part("control: a person deleted before the read is not noted");
  {
    const store = await shop();
    await legacyGrant(store, BUYER);
    await forgetImportedPerson(store.statsId, BUYER);
    is("nothing reads", await importedFor(store, BUYER), []);
    is("no note", (await redis.pipeline([["HGET", importedWhoKey(store.statsId!), BUYER]]))[0], null);
  }

  part("the note's fence is priced where the read is metered");
  {
    const calls = (script: string) => (script.match(/redis\.call\(/g) ?? []).length;
    // Upstash bills a script as one command plus every redis.call it runs: the fence adds exactly its EXISTS.
    is("ORDER_WRITE_IF_KEY runs one redis.call more than ORDER_WRITE, the EXISTS of the grants", calls(ORDER_WRITE_IF_KEY) - calls(ORDER_WRITE), 1);
    is("the orders page counts it: the HLEN, the record, the note's script and count, and the fence", ORDERS_IMPORTED_COMMANDS, 5);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
