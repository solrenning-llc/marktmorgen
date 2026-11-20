/**
 * The all-time sales reading must not recreate the store's caches after erasure
 * (Codex L-20261120-0545): readAllTimeSales waits on up to 30 pages of Stripe reads, and the
 * erasure walk can delete nl:next:<statsId> and nl:stats:<statsId>:allsales meanwhile; both late
 * writes are fenced on the store's life.
 */
import { readAllTimeSales } from "@/lib/stats";
import {
  ERASING_KEY,
  claimHandle,
  ensureStatsId,
  ensureStoreId,
  erasingField,
  setStripeAccount,
  storeForEmail,
  storeIdCommand,
  storeRef,
  type Store,
} from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_all_sales_erasure";

const S = Date.parse("2026-11-01T12:00:00Z") / 1000;
/** Run once, inside the first Stripe read, while the reading is still in flight. */
let during: (() => Promise<void>) | null = null;
/** The handle the sales are named for (the reading keeps only this store's sales). */
let handle = "";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if ((init?.method ?? "GET") === "GET" && path.endsWith("/checkout/sessions")) {
    const step = during;
    during = null;
    if (step) await step();
    const meta = { store: handle, product: "p1" };
    return answer({
      data: [
        { id: "cs_test_allsales0001", status: "complete", payment_status: "paid", amount_total: 5000, currency: "usd", created: S, payment_intent: "pi_allsales0001", customer_details: { email: "a@example.com" }, metadata: meta },
        { id: "cs_test_allsales0002", status: "complete", payment_status: "paid", amount_total: 7000, currency: "usd", created: S - 60, payment_intent: "pi_allsales0002", customer_details: { email: "a@example.com" }, metadata: { ...meta, product: "p2" } },
      ],
      has_more: false,
    });
  }
  return answer({ data: [], has_more: false });
}) as typeof fetch;

async function seed(owner: string, name: string): Promise<Store> {
  handle = name;
  await claimHandle(owner, name, "All Sales", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_synthAllSales", true);
  return (await storeForEmail(owner))!;
}

const exists = (key: string) => Number(redis.run(["EXISTS", key]));

async function main(): Promise<void> {
  part("A live store keeps both caches");
  redis.clear();
  const live = await seed("allsales-live@example.com", "allsaleslive");
  const read = await readAllTimeSales(live);
  is("the live store reads its two sales", read?.totals, { sales: 2, cents: 12000 });
  is("the all-time reading is kept", exists(`nl:stats:${live.statsId}:allsales`), 1);
  is("the buyer paths are kept", exists(`nl:next:${live.statsId}`), 1);

  part("An erasure that starts during the read leaves neither cache behind");
  redis.clear();
  const store = await seed("allsales-erasure@example.com", "allsaleserase");
  const allSales = `nl:stats:${store.statsId}:allsales`;
  const next = `nl:next:${store.statsId}`;
  during = async () => {
    await redis.pipeline([
      ["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())],
      ["DEL", storeIdCommand(store.sid)[1], allSales, next],
    ]);
  };
  const late = await readAllTimeSales(store);
  is("the request that started the read still gets its answer", late?.totals, { sales: 2, cents: 12000 });
  is("the erased store's all-time reading stays absent", exists(allSales), 0);
  is("the erased store's buyer paths stay absent", exists(next), 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
