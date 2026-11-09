/**
 * A come-back offer the store's email figure could not be read for is not
 * counted as sent (lib/winback-send.ts sendWinBacks, lot 2 pre-review W2): the
 * figure answered unknown, so sendEmailOutcome says `refused` (no sender was
 * asked), this run's own marks and the offer's link go, and the next run,
 * inside the same window, sends the offer once, never twice; before, false was
 * kept as sent and the offer was lost for 90 days.
 *
 * Stripe and the email sender are played by a stand-in for `fetch`; ids are synthetic.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWinBack, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { sendWinBacks } from "@/lib/winback-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const now = Date.now();
const nowS = Math.floor(now / 1000);
const OWNER = "meter-winback@example.com";

const emails: { to: string[]; text: string }[] = [];
const events: Record<string, unknown>[] = [];
const customers = new Map<string, string>();
/** Customers whose next read fails once, as Stripe answering 500. */
const customerDown = new Set<string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as { to: string[]; text: string });
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") {
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    return answer({ object: "list", data: events.filter((e) => Number(e.created) >= gte && Number(e.created) <= lte), has_more: false });
  }
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer && customerDown.delete(customer[1])) return new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 500 });
  if (customer) return answer({ id: customer[1], email: customers.get(customer[1]) ?? null });
  if (path === "/subscriptions") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

type Commands = Parameters<typeof redis.pipeline>[0];
async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_l6_winback_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();
  if (!(await claimHandle(OWNER, "meterwinback", "Harbor Kitchen", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER); await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLoopWinBack", true);
  await setSubscription(OWNER, { customerId: "cus_LoopWbOwner1", subscriptionId: "sub_LoopWbOwner1", active: true, tier: "pro", period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const meta = { store: "meterwinback", product: club.product.id };
  let n = 0;
  const member = async () => {
    n += 1; const id = String(n).padStart(4, "0");
    const customer = `cus_LoopWbMember${id}`; const email = `m${id}@example.com`;
    customers.set(customer, email);
    await upsertContact(store.listId as string, email, { agreed: true, explicit: true, source: "buyer" }, ROOM);
    events.push({ id: `evt_LoopWb${id}`, type: "customer.subscription.deleted", created: nowS - 8 * DAY,
      data: { object: { id: `sub_LoopWb${id}`, customer, ended_at: nowS - 8 * DAY, metadata: meta, items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] } } } });
    return { email, customer };
  };
  const sentTo = (email: string) => emails.filter((e) => [e.to].flat()[0] === email);
  const base = redis.pipeline.bind(redis);

  part("W2: the store's email figure throws once before the provider: not sent now, sent once by the next run");
  const b = await member();
  let thrown = 0;
  redis.pipeline = async (c: Commands) => {
    if (thrown === 0 && c.some((x) => String(x[1]).startsWith("nl:allow:email:"))) { thrown += 1; throw new Error("Redis 500 before send"); }
    return base(c);
  };
  const first = await sendWinBacks(Date.now() + 30_000, now);
  redis.pipeline = base;
  is("the figure's write threw once", thrown, 1);
  is("nothing was sent in the first run", sentTo(b.email).length, 0);
  is("nothing was counted as sent", first.sent, 0);
  is("no come-back link is left behind", redis.keys().filter((k) => k.startsWith("nl:wb:link:")).length, 0);
  const second = await sendWinBacks(Date.now() + 30_000, now);
  is("the next run sends it", sentTo(b.email).length, 1);
  is("and counts it", second.sent, 1);
  await sendWinBacks(Date.now() + 30_000, now);
  await sendWinBacks(Date.now() + 30_000, now + DAY);
  is("never twice", sentTo(b.email).length, 1);
  done();
}
main().catch((error: unknown) => { console.error(error); process.exit(1); });
