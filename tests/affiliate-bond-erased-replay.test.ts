/**
 * Privacy and money (erase-then-replay): a buyer deleted from a store is never tied to an affiliate again
 * (lib/affiliate-bond.ts rememberBuyer). The bond makes every later purchase of that buyer earn the affiliate a
 * commission, under a fingerprint of their address; deleting the person removes it (forgetBondPerson). But the
 * thank-you page re-runs noteSession on every load, with no age limit, and so did the bond: reloading the page of an
 * order paid before the deletion wrote the bond back. Now a store's deletion print (lib/suppression.ts) is read first:
 * a deleted buyer is not bonded, and a print that cannot be read writes nothing either (the bond is never what makes
 * a sale; a sale's own click or code still credits it). Synthetic store; nothing reaches anything real.
 */
import { bondFor, forgetBondPerson, rememberBuyer } from "@/lib/affiliate-bond";
import { suppressCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LIST = "b0d0e1a5ed00";
const STATS = "bondstats0001";
const AFF = "a1b2c3d4e5f6";
const OTHER = "0f1e2d3c4b5a";
const WHO = "deleted.buyer@example.com";
const store = (rule: "first" | "last" = "first") =>
  ({ sid: "sidbond01", statsId: STATS, listId: LIST, affiliates: { enabled: true, lifetime: true, rule } }) as unknown as Store;

async function main(): Promise<void> {
  for (const rule of ["first", "last"] as const) {
    part(`On ${rule} click: bonded, then deleted, then the old order's page reloaded`);
    redis.clear();
    await rememberBuyer(store(rule), WHO, AFF, rule);
    is("before the deletion the buyer is bonded", await bondFor(store(rule), WHO), AFF);
    await forgetBondPerson(STATS, WHO);
    redis.run(suppressCommand(LIST, WHO, 1_793_880_000));
    await rememberBuyer(store(rule), WHO, AFF, rule);
    is("the replay writes no bond back", await bondFor(store(rule), WHO), "");
    await rememberBuyer(store(rule), " Deleted.Buyer@Example.com ", OTHER, rule);
    is("nor does another affiliate's link, written another way", await bondFor(store(rule), WHO), "");
    await rememberBuyer(store(rule), "kept.buyer@example.com", AFF, rule);
    is("a buyer never deleted is bonded as before", await bondFor(store(rule), "kept.buyer@example.com"), AFF);
  }

  part("A deletion print that cannot be read writes nothing");
  redis.clear();
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "HEXISTS" && commands[0][1] === suppressedKey(LIST) && commands[0][2] === suppressionPrint(LIST, WHO)) return ["QUEUED"];
    return real(commands);
  }) as typeof redis.pipeline;
  await rememberBuyer(store(), WHO, AFF, "first");
  redis.pipeline = real;
  is("an answer of another shape is never read as 'not deleted'", await bondFor(store(), WHO), "");

  part("A store with no list has deleted nobody");
  redis.clear();
  await rememberBuyer({ ...store(), listId: null } as unknown as Store, WHO, AFF, "first");
  is("its buyers are bonded as before", await bondFor({ ...store(), listId: null } as unknown as Store, WHO), AFF);
  done();
}

void main();
