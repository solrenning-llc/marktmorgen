/**
 * Claude 1's MEDIUM on #1824 (MR, a public read with no ceiling): the policy
 * page is public and dynamic, and builds its facts from every visible
 * product's listing, up to MAX_PRODUCTS GETs a view. Those reads are paid for
 * from the store's public requests before any listing is read, one listing a
 * product as a bundle's items are (bundleItemUnits, held over bundleItemRead
 * here for every catalog size), and a refused take reads nothing: the page
 * shows the resting page instead (policyInputPaid). Synthetic store, the real
 * catalog writers and the in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { visibleIds } from "@/lib/catalog";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { bundleItemUnits } from "@/lib/page-read-rules";
import * as policy from "@/lib/store-policy-input";
import { bundleItemRead } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Commands = (string | number)[][];

async function main(): Promise<void> {
  part("The units cover the reads for every catalog size");
  let short = 0;
  for (let n = 1; n <= MAX_PRODUCTS; n += 1) if (bundleItemUnits(n) * laterPageCost() < bundleItemRead(n)) short += 1;
  is(`bundleItemUnits(n) x a later page covers n listings, n = 1..${MAX_PRODUCTS}`, short, 0);

  redis.clear();
  const owner = "policy-paid@example.test";
  await claimHandle(owner, "policypaid", "Policy Paid", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_PolicyPaid01", subscriptionId: "sub_PolicyPaid01", active: true, period: paidPeriod() });
  for (let i = 0; i < 40; i++) if (!(await addProduct(owner, `Guide ${i}`, "", "19", null)).ok) throw Error("fixture product failed");
  const shop = (await storeForEmail(owner))!;
  const listed = visibleIds(shop).length;
  const now = Date.now();
  const window = allowanceWindow(shop, now)!;
  const requests = `nl:traffic:r:${await storeFolder(storeRef(shop))}:${window.id}`;
  const paid = (policy as Record<string, unknown>).policyInputPaid as ((store: typeof shop) => Promise<unknown>) | undefined;
  is("the paid reader exists", typeof paid, "function");

  const pipe = redis.pipeline.bind(redis);
  let listingReads = 0;
  redis.pipeline = (async (commands: Commands) => {
    listingReads += commands.filter((c) => (c[0] === "GET" || c[0] === "MGET") && String(c[1]).includes(":l:")).length;
    return pipe(commands);
  }) as typeof redis.pipeline;

  part("A store whose public requests are spent: nothing read, the resting page");
  redis.run(["SET", requests, String(10 ** 12), "EX", 3600]);
  listingReads = 0;
  const refused = paid ? await paid(shop) : "absent";
  is("refused: resting", refused, "resting");
  is("and no listing was read", listingReads, 0);

  part("A store with room: the reads are paid for before they are made");
  redis.run(["DEL", requests]);
  listingReads = 0;
  const input = paid ? ((await paid(shop)) as { sellsDigital?: boolean }) : null;
  is("the facts are built", typeof input === "object" && input !== null && "sellsDigital" in input, true);
  is(`at least ${bundleItemUnits(listed)} requests taken for ${listed} listings`, Number(redis.run(["GET", requests]) ?? 0) >= bundleItemUnits(listed), true);
  is("the listings outside the head were read", listingReads > 0, true);
  redis.pipeline = pipe;

  part("The page uses the paid reader and the resting page");
  const page = readFileSync("app/[handle]/policies/page.tsx", "utf8");
  is("the page reads through policyInputPaid", page.includes("await policyInputPaid(store)"), true);
  is("a refused read draws the resting page", page.includes("<StoreResting store={store} />"), true);
  is("a resting or suspended store is resting here too", [page.includes("await isResting(store)"), page.includes("store.suspended")], [true, true]);
  done();
}

void main();
