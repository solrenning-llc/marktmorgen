/**
 * Claude 4, second review of #2714 (LEVE B, proof claude4/review-2714-proof@9b710162): the winback window is two
 * days wide and the cron runs once a day, so each ended membership is seen by two runs. Stripe lists events newest
 * first; a run that spent its 100 offers on the newest left 50 of 150 ended on day 1 unseen when 100 more ended on
 * day 2. The run goes oldest first, so all 250 are reached in the three runs that see them.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWinBack, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { sendWinBacks } from "@/lib/winback-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const t0 = Date.now();
const OWNER = "c4-wb-order@example.com";
const events: { id: string; created: number; data: unknown }[] = [];
const customers = new Map<string, string>();
const looked: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") {
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    const after = url.searchParams.get("starting_after");
    // Newest first, as Stripe lists events.
    const all = events.filter((e) => e.created >= gte && e.created <= lte).sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
    const from = after ? all.findIndex((e) => e.id === after) + 1 : 0;
    return answer({ object: "list", data: all.slice(from, from + 100), has_more: from + 100 < all.length });
  }
  // The customers of one address (lib/winback-send.ts reads every one of them, audit R43): those set above.
  if (path === "/customers") return answer({ object: "list", data: [...customers].filter(([, e]) => e === url.searchParams.get("email")).map(([id, email]) => ({ id, object: "customer", email })), has_more: false });
  if (path === "/customers/search") {
    const address = (url.searchParams.get("query")?.match(/^email:"([^"]*)"$/)?.[1] ?? "").toLowerCase();
    return answer({ object: "search_result", data: [...customers].filter(([, e]) => e.toLowerCase() === address).map(([id, email]) => ({ id, object: "customer", email })), has_more: false, next_page: null });
  }
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) {
    looked.push(customer[1]);
    return answer({ id: customer[1], email: customers.get(customer[1]) ?? null });
  }
  if (path === "/subscriptions") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_c4_wb_order_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();
  const made = await claimHandle(OWNER, "cfourwb", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestCfourWb01", true);
  await setSubscription(OWNER, { customerId: "cus_CfourOwner1", subscriptionId: "sub_CfourOwner1", active: true, tier: "pro", period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const meta = { store: "cfourwb", product: club.product.id };
  const nowS = Math.floor(t0 / 1000);
  // Group 1 ended 7 days and an hour before run 1; group 2 a day later.
  const g1 = nowS - 7 * DAY - 3600;
  const add = async (prefix: string, n: number, created: number) => {
    for (let i = 0; i < n; i += 1) {
      const id = `${prefix}${String(i).padStart(4, "0")}`;
      const cus = `cus_${id}`;
      customers.set(cus, `${id.toLowerCase()}@example.com`);
      await upsertContact(store.listId as string, `${id.toLowerCase()}@example.com`, { agreed: true, explicit: true, source: "buyer" }, ROOM);
      events.push({ id: `evt_${id}`, created: created + i, data: { object: { id: `sub_${id}`, customer: cus, ended_at: created, metadata: meta, items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] } } } });
    }
  };
  await add("DayOne", 150, g1);
  await add("DayTwo", 100, g1 + DAY);

  part("Three daily runs over two days of ended memberships, listed newest first by Stripe");
  await sendWinBacks(Date.now() + 60_000, t0);
  await sendWinBacks(Date.now() + 60_000, t0 + DAY * 1000);
  await sendWinBacks(Date.now() + 60_000, t0 + 2 * DAY * 1000);
  const ones = new Set(looked.filter((c) => c.startsWith("cus_DayOne")));
  const twos = new Set(looked.filter((c) => c.startsWith("cus_DayTwo")));
  is("all 100 of day 2 looked at", twos.size, 100);
  is("all 150 of day 1 looked at before they leave the window", ones.size, 150);
  is("no run looked at more than its 100, and nobody twice", looked.length, new Set(looked).size);
  done();
}

void main();
