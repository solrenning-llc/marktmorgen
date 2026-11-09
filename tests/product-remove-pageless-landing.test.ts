/**
 * A product's campaign landings go with the product even when its page was emptied first, and a removal whose page
 * step fails before them is never said finished (Claude 5's second review of #1947, the MEDIUM and the LOW). The real
 * product-removal route, session and writers (MemoryRedis); no outside request.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductPage, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { saveLanding } from "@/lib/campaign-landing-store";
import { EMPTY_PAGE, emptyBlock } from "@/lib/sales-page";
import { writePage } from "@/lib/sales-page-store";
import { dataKey } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

let outside = 0;
globalThis.fetch = (async () => {
  outside++;
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function fixture(handle: string) {
  redis.clear();
  const owner = `${handle}@example.test`;
  await claimHandle(owner, handle, "Synthetic store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_PagelessLanding", true);
  await setSubscription(owner, { customerId: "cus_PagelessLanding", subscriptionId: "sub_PagelessLanding", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic course", "", "19", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  await setProductPage(owner, id, true);
  const shop = (await storeForEmail(owner))!;
  await writePage(shop.statsId!, id, { ...EMPTY_PAGE, blocks: [emptyBlock("hero")] }, shop);
  await saveLanding(shop.statsId!, id, { campaign: "synthetic", headline: "Synthetic course", sub: "Known campaign content", button: "Read more" }, shop);
  const session = await openSession(owner);
  const remove = async () => {
    const response = await POST(
      new NextRequest("https://marktmorgen.com/api/store/product", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify({ action: "remove", id }),
      }),
    );
    return { status: response.status, body: (await response.json()) as { ok?: boolean; cleanupPending?: boolean } };
  };
  const landing = `nl:product:landing:${shop.statsId}:${id}`;
  const left = async () => {
    const [record, slot, versions] = await redis.pipeline([["GET", landing], ["HGET", dataKey(shop)!, `al:${id}`], ["LLEN", `nl:product:pages:${shop.statsId}:${id}`]]);
    return { record, slot, versions };
  };
  return { owner, id, shop, remove, left };
}

async function main(): Promise<void> {
  const pipe = redis.pipeline.bind(redis);

  part("A: the page was emptied (as the page route does), then the product removed");
  const a = await fixture("pageless-a");
  await writePage(a.shop.statsId!, a.id, { ...EMPTY_PAGE, blocks: [] }, a.shop);
  await setProductPage(a.owner, a.id, false);
  is("(the campaign is kept and counted before the removal)", typeof (await a.left()).record, "string");
  const removedA = await a.remove();
  const afterA = await a.left();
  is("A: removed", removedA.body.ok, true);
  is("A: the campaign record went with the product", afterA.record, null);
  is("A: its room was given back", afterA.slot, null);
  is("A: the page's versions went too", afterA.versions, 0);

  part("B: the page's own deletion fails before the campaigns");
  const b = await fixture("pageless-b");
  let reached = 0;
  redis.pipeline = (async (cs: (string | number)[][]) => {
    if (cs.some((c) => c[0] === "DEL" && String(c[1]).startsWith(`nl:product:page:${b.shop.statsId}:${b.id}`))) {
      reached++;
      throw new Error("synthetic transport failure");
    }
    return pipe(cs);
  }) as typeof redis.pipeline;
  let removedB: Awaited<ReturnType<typeof b.remove>>;
  try {
    removedB = await b.remove();
  } finally {
    redis.pipeline = pipe;
  }
  const afterB = await b.left();
  is("B: the failure was reached", reached > 0, true);
  is("B: a campaign kept is never said a removal finished", Boolean(removedB.body.ok && afterB.record !== null && !removedB.body.cleanupPending), false);
  is("B: the campaigns are still tried, and go", afterB.record, null);
  is("no outside request", outside, 0);
  done();
}
void main();
