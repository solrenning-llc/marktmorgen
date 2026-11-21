/**
 * 542 [CM1], review of #3007 (7 November 2026): the locked spaces' products
 * are read in rounds, and what the rounds really read is held against what
 * they paid. Four spaces reach the same kind of bundle of 20 items in
 * different rounds (behind 0, 1, 3 and 7 hidden products), on a synthetic
 * store with the stand-in Redis and a stubbed Stripe.
 *
 * Before the fix each round handed its bundles to productsBuyableNow, which
 * read their items again (offeredItems) and the pre-orders again (soonState):
 * 80 item reads and 4 pre-order reads for the 6 requests paid. At the
 * registry's figures for a listing read (collectionRead, bundleItemRead)
 * that cost $0.000431 against the $0.000380 paid; the commands and bytes
 * alone stayed under it, so that check is only a bound, and the proof is
 * the read counts and the registry's figures. Every command the call sends
 * is counted here, each key of a GET or MGET as one, with the bytes of
 * every answer.
 *
 * A read that fails while the way in is worked out (the pre-orders, or a
 * bundle's item) answers empty, which the page draws as "unknown", never
 * "none" (access not available) for a product that could be on sale.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setCommunity, setProductBundle, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { type CommunityConfig, freshConfig, newItemId } from "@/lib/community";
import { unlocksOf } from "@/lib/community-locked";
import { bundleItemUnits, collectionUnits } from "@/lib/page-read-rules";
import { laterPageCost } from "./traffic-cost";
import { COMMAND, DB_BYTE, READ_LISTING_BYTES, bundleItemRead, collectionRead } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "cm1-reads-owner@example.com";

async function made(title: string, price: string): Promise<string> {
  const added = await addProduct(OWNER, title, "", price, null);
  if (!added.ok) throw new Error(`no product ${title}`);
  await setProductLink(OWNER, added.product.id, `https://example.com/${added.product.id}`);
  return added.product.id;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_cm1_reads_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_cm1_reads_only_a_stand_in";
  await claimHandle(OWNER, "lockedreads", "Locked Reads", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLkReads01", true);
  await setSubscription(OWNER, { customerId: "cus_LockedReads01", subscriptionId: "sub_LockedReads01", active: true, tier: "scale", period: paidPeriod() } as never);
  const children: string[] = [];
  for (let n = 0; n < 20; n++) children.push(await made(`Child ${n}`, "5"));
  const bundles: string[] = [];
  for (let n = 0; n < 4; n++) {
    const added = await addProduct(OWNER, `Bundle ${n}`, "", "19", null);
    if (!added.ok) throw new Error("no bundle");
    const made = await setProductBundle(OWNER, added.product.id, children);
    if (!made.ok) throw new Error(`bundle ${JSON.stringify(made)}`);
    bundles.push(added.product.id);
  }
  for (const child of children) await setProductHidden(OWNER, child, true);
  const hidden: string[] = [];
  for (let n = 0; n < 11; n++) {
    const product = await made(`Hidden ${n}`, "5");
    await setProductHidden(OWNER, product, true);
    hidden.push(product);
  }
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const spaces = [newItemId(), newItemId(), newItemId(), newItemId()];
  const config: CommunityConfig = {
    ...freshConfig(store.name),
    access: [...bundles, ...hidden],
    spaces: [
      { id: newItemId(), name: "General", about: "", creatorOnly: false, only: [], level: 0 },
      { id: spaces[0], name: "S1", about: "", creatorOnly: false, only: [bundles[0]], level: 0, shown: true },
      { id: spaces[1], name: "S2", about: "", creatorOnly: false, only: [hidden[0], bundles[1]], level: 0, shown: true },
      { id: spaces[2], name: "S3", about: "", creatorOnly: false, only: [hidden[1], hidden[2], hidden[3], bundles[2]], level: 0, shown: true },
      { id: spaces[3], name: "S4", about: "", creatorOnly: false, only: [...hidden.slice(4, 11), bundles[3]], level: 0, shown: true },
    ] as CommunityConfig["spaces"],
  };

  // Every command sent while the way in is worked out, each key of a GET or MGET counted as one, and every answer's bytes.
  const original = redis.pipeline.bind(redis);
  const childSet = new Set(children);
  const productSet = new Set([...bundles, ...hidden]);
  const listingReads = new Map<string, number>();
  let commands = 0, bytes = 0, soonReads = 0, largest = 0;
  redis.pipeline = (async (sent: (string | number)[][]) => {
    for (const command of sent) {
      const name = String(command[0]);
      if (name === "SMEMBERS") soonReads++;
      if (name === "GET" || name === "MGET") {
        commands += command.length - 1;
        for (const key of command.slice(1).map(String)) {
          if (!key.startsWith("nl:catalog:")) continue;
          const id = [...childSet, ...productSet].find((each) => key.endsWith(each));
          if (id) listingReads.set(id, (listingReads.get(id) ?? 0) + 1);
        }
      } else commands++;
    }
    const answers = await original(sent);
    for (const answer of answers) {
      bytes += Buffer.byteLength(JSON.stringify(answer ?? null), "utf8");
      for (const value of Array.isArray(answer) ? answer : [answer]) largest = Math.max(largest, Buffer.byteLength(JSON.stringify(value ?? null), "utf8"));
    }
    return answers;
  }) as typeof redis.pipeline;
  let units = 0;
  let ways: Awaited<ReturnType<typeof unlocksOf>>;
  try {
    ways = await unlocksOf(store, config, async (n) => {
      units += n;
      return true;
    });
  } finally {
    redis.pipeline = original;
  }

  part("Four spaces reach a bundle of 20 items in different rounds");
  is("each names its bundle", spaces.map((space) => (ways?.[space] as { title?: string } | undefined)?.title), ["Bundle 0", "Bundle 1", "Bundle 2", "Bundle 3"]);
  const itemReads = children.reduce((sum, id) => sum + (listingReads.get(id) ?? 0), 0);
  const productsRead = [...productSet].filter((id) => listingReads.has(id)).length;
  console.log(JSON.stringify({ units, itemReads, productsRead, soonReads, commands, bytes, largest }));
  is("paid: the 15 products and the 20 items, once (4 + 2 requests)", units, collectionUnits(15) + bundleItemUnits(20));

  part("Nothing is read twice");
  is("the pre-orders are read once", soonReads, 1);
  is("each item is read once, though four bundles hold it in four rounds", itemReads, children.length);
  is("no listing is read more than once", [...listingReads.values()].filter((times) => times > 1).length, 0);

  part("What the rounds really read is inside what they paid");
  const paid = units * laterPageCost();
  is("every value read is within a listing's bytes, the registry's figure for one", largest <= READ_LISTING_BYTES, true);
  // Only a bound: the code before the fix passed it too. The proof is the read counts above and the registry's figures below.
  is("bound only, not the proof of the fix: the commands and bytes really sent cost less than the requests paid", commands * COMMAND + bytes * DB_BYTE <= paid, true);
  // Every one of the 15 products is judged (its stock and keys), whether its listing came from Redis or the catalog's head.
  is("the reads, at the registry's figures, cost less than the requests paid", collectionRead(productSet.size) + bundleItemRead(itemReads) <= paid, true);

  part("A read that fails answers unknown, never none");
  const failing = async (fails: (command: (string | number)[]) => boolean) => {
    redis.pipeline = (async (sent: (string | number)[][]) => {
      if (sent.some(fails)) throw new Error("synthetic lost reply");
      return original(sent);
    }) as typeof redis.pipeline;
    try {
      return await unlocksOf(store, config, async () => true);
    } finally {
      redis.pipeline = original;
    }
  };
  is("the pre-orders' SMEMBERS fails: empty (unknown), not none", await failing((command) => command[0] === "SMEMBERS"), {});
  const itemKey = (key: string | number) => String(key).startsWith("nl:catalog:") && children.some((id) => String(key).endsWith(id));
  is("a bundle item's GET fails: empty (unknown), not none", await failing((command) => (command[0] === "GET" || command[0] === "MGET") && command.slice(1).some(itemKey)), {});
  const control = await failing(() => false);
  is("control: with nothing failing, each space names its bundle again", spaces.map((space) => (control?.[space] as { title?: string } | undefined)?.title), ["Bundle 0", "Bundle 1", "Bundle 2", "Bundle 3"]);
  done();
}

void main();
