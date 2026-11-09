/**
 * Audit proof (calls, privacy): the store's bookings calendar address (/api/store/calendar/<token>.ics) is shown in the
 * studio to every teammate with the "settings" permission (app/studio/page.tsx, calendarView; an admin has it). The file
 * names each booker ("Name <email>"). Taking that teammate off the team (lib/team.ts removeMember) pauses their API keys
 * but leaves this address working: the former admin keeps a live feed of every buyer's name and address until the owner
 * happens to press "new address".
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { putMember, removeMember } from "@/lib/team";
import { calendarView, ensureFeedToken } from "@/lib/calendar-sync";
import type { CallSetup } from "@/lib/call-setup";
import { GET as feedRoute } from "@/app/api/store/calendar/[token]/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let checkouts: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const listing = String(input).includes("/checkout/sessions?") && (init?.method ?? "GET") === "GET";
  return new Response(JSON.stringify({ object: "list", data: listing ? checkouts : [], has_more: false }), { status: 200 });
}) as typeof fetch;

const OWNER = "owner@example.com";
const ADMIN = "former.admin@example.com";
const BUYER = "ana.buyer@example.com";
const weekly = { kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []], noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_team_scheduling_only";
  await claimHandle(OWNER, "harbor", "Harbor studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_harbor00001", subscriptionId: "sub_harbor00001", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, weekly);
  const store = (await storeForEmail(OWNER)) as Store;
  checkouts = [{
    id: `cs_test_feedafter${"0".repeat(12)}`, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - 3_600, amount_total: 12000, currency: "usd", customer_details: { email: BUYER, name: "Ana Buyer" },
    metadata: { store: store.handle, kind: "call", product: made.product.id, start: String(Date.now() + 3 * 86_400_000), end: String(Date.now() + 3 * 86_400_000 + 3_600_000) },
    payment_intent: { id: "pi_feedafter", status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  }];

  part("An admin is shown the bookings address in the studio");
  is("added as admin", await putMember(store, ADMIN, "admin"), true);
  await ensureFeedToken(store);
  const seen = (await calendarView((await storeForEmail(OWNER)) as Store)).subscribeUrl ?? "";
  const token = seen.slice(seen.lastIndexOf("/") + 1).replace(/\.ics$/, "");
  const ask = async () => {
    const answer = await feedRoute(new Request(seen), { params: Promise.resolve({ token }) });
    return { status: answer.status, names: (await answer.text()).includes(BUYER) };
  };
  is("the address answers, naming the buyer", await ask(), { status: 200, names: true });

  part("The admin is taken off the team");
  is("removed", await removeMember((await storeForEmail(OWNER)) as Store, ADMIN), true);
  redis.run(["DEL", `nl:cal:pace:${store.statsId}`]);
  // EXPECTED (safe): the address a former teammate copied stops, as their API keys do. ON MAIN: it still names the buyer.
  const after = await ask();
  is("the address the former admin copied no longer names the store's buyers", after.status === 200 && after.names, false);
  done();
}

void main();
