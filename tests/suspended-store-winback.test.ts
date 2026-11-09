/**
 * A store switched off after notices about its content (`store.suspended`,
 * lib/takedown.ts) sends no come-back offer (lib/winback-send.ts,
 * sendWinBacks): nothing is read from its Stripe account, no mark is taken
 * and nothing is sent, so an ended membership still in the offer's window is
 * offered once the store is back on. Synthetic data only, in-memory Redis,
 * stand-in Stripe and Resend.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, noteTakedown, setProductLink, setStripeAccount, setSubscription, setWinBack, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { sendWinBacks, winbacksSent } from "@/lib/winback-send";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const t0 = Date.now();
const OWNER = "switched-off-wb@example.com";
const ACCOUNT = "acct_1TestSwOffWb01";
const stripeReads: string[] = [];
const emails: { to: unknown; subject: unknown }[] = [];
let ended: unknown[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: unknown; subject?: unknown };
    emails.push({ to: body.to, subject: body.subject });
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  stripeReads.push(path);
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") return answer({ object: "list", data: ended, has_more: false });
  if (path === "/customers/cus_SwOffMember1") return answer({ id: "cus_SwOffMember1", email: "member@example.com" });
  if (path === "/subscriptions") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_switched_off_wb_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();
  const made = await claimHandle(OWNER, "swoffwb", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_SwOffOwner1", subscriptionId: "sub_SwOffOwner1", active: true, tier: "pro", period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  await upsertContact(store.listId as string, "member@example.com", { agreed: true, explicit: true, source: "buyer" }, ROOM);
  const nowS = Math.floor(t0 / 1000);
  const endedAt = nowS - 7 * DAY - 3600;
  ended = [{ id: "evt_SwOff0001", created: endedAt, data: { object: { id: "sub_SwOffMember1", customer: "cus_SwOffMember1", ended_at: endedAt, metadata: { store: "swoffwb", product: club.product.id }, items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] } } } }];
  /** The membership's own mark (lib/winback-send.ts, sentKey): taken only when an offer is looked at. */
  const marked = async () => (await redisPipeline([["EXISTS", `nl:wb:${ACCOUNT}:sub_SwOffMember1`]]))[0];

  part("A come-back offer while the store is switched off");
  await noteTakedown(OWNER, null, true);
  const off = await sendWinBacks(Date.now() + 60_000, t0);
  is("nothing is sent", [off.sent, emails.length], [0, 0]);
  is("nothing is read from the creator's Stripe account", stripeReads, []);
  is("no mark is taken, so nothing is held back for when it is back on", await marked(), 0);
  is("and the count of offers sent does not move", await winbacksSent((await storeForEmail(OWNER))!), 0);

  part("Back on, the next day, the membership still in the offer's window: offered once");
  await noteTakedown(OWNER, null, false);
  const on = await sendWinBacks(Date.now() + 60_000, t0 + DAY * 1000);
  is("one offer goes out, to the member", [on.sent, emails.length, emails[0]?.to], [1, 1, ["member@example.com"]]);
  const again = await sendWinBacks(Date.now() + 60_000, t0 + DAY * 1000 + 3600_000);
  is("and only once", [again.sent, emails.length], [0, 1]);
  done();
}

void main();
