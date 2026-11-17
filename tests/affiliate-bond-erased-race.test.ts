/**
 * Privacy and money, the two findings on #3927 (Claude 1 cloud and Claude 2 cloud F, 12/11/2026):
 *
 * 1. An erasure that lands between rememberBuyer's read of the deletion print and its write left a bond for the
 *    deleted buyer that nothing removes afterwards (the erasure writes the print, then HDELs the bond).
 * 2. Any print, however old, blocked the bond for good, also for a purchase made after the deletion: a buyer
 *    deleted in January who buys again in March through an affiliate's link was never bonded, so under a lifetime
 *    program every later purchase without a click lost that affiliate's commission. Only a print at or after the
 *    sale (a replay of an order paid before the deletion) blocks it, as KEEP_RECEIPT does in lib/paypal-delivery.ts.
 *
 * Synthetic store; MemoryRedis (tests/redis-stub.ts); nothing reaches anything real.
 */
import { bondFor, forgetBondPerson, rememberBuyer } from "@/lib/affiliate-bond";
import { suppressCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LIST = "b0d0e1a5ed00";
const STATS = "bondstats0002";
const AFF = "a1b2c3d4e5f6";
const WHO = "raced.buyer@example.com";
const NOW = 1_793_880_000;
const store = (rule: "first" | "last") =>
  ({ sid: "sidbond02", statsId: STATS, listId: LIST, affiliates: { enabled: true, lifetime: true, rule } }) as unknown as Store;
const remember = rememberBuyer as unknown as (store: Store, email: string, aff: string, rule: "first" | "last", paidAt?: number) => Promise<void>;

/** Whether a command reads this buyer's deletion print. */
const readsPrint = (command: (string | number)[]) =>
  (command[0] === "HEXISTS" || command[0] === "HGET") && command[1] === suppressedKey(LIST) && command[2] === suppressionPrint(LIST, WHO);

async function main(): Promise<void> {
  const real = redis.pipeline.bind(redis);
  for (const rule of ["first", "last"] as const) {
    part(`On ${rule} click: the buyer is erased right after the print was read, before the bond is written`);
    redis.clear();
    let erased = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await real(commands);
      if (!erased && commands.length === 1 && readsPrint(commands[0])) {
        // lib/person-erasure.ts: the print first, then the bond forgotten.
        erased = true;
        redis.run(suppressCommand(LIST, WHO, NOW + 10));
        await forgetBondPerson(STATS, WHO);
      }
      return replies;
    }) as typeof redis.pipeline;
    await remember(store(rule), WHO, AFF, rule, NOW);
    redis.pipeline = real;
    is("the erasure did run in between", erased, true);
    is("no bond is left for the erased buyer", await bondFor(store(rule), WHO), "");

    part(`On ${rule} click: deleted a month ago, then a new purchase through an affiliate's link`);
    redis.clear();
    redis.run(suppressCommand(LIST, WHO, NOW - 30 * 86_400));
    await remember(store(rule), WHO, AFF, rule, NOW);
    is("a purchase made after the deletion bonds the buyer", await bondFor(store(rule), WHO), AFF);

    part(`On ${rule} click: the page of an order paid before the deletion, reloaded`);
    redis.clear();
    redis.run(suppressCommand(LIST, WHO, NOW));
    await remember(store(rule), WHO, AFF, rule, NOW - 3_600);
    is("paid before the deletion: no bond", await bondFor(store(rule), WHO), "");
    await remember(store(rule), WHO, AFF, rule, NOW);
    is("paid in the same second as the deletion: no bond", await bondFor(store(rule), WHO), "");
    await remember(store(rule), WHO, AFF, rule);
    is("no time for the sale: any print blocks it", await bondFor(store(rule), WHO), "");
  }

  part("A print whose time does not read writes nothing, even for a later sale");
  redis.clear();
  redis.run(["HSET", suppressedKey(LIST), suppressionPrint(LIST, WHO), "soon"]);
  await remember(store("first"), WHO, AFF, "first", NOW);
  is("an unreadable print is never read as 'deleted before'", await bondFor(store("first"), WHO), "");
  done();
}

void main();
