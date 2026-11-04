/**
 * Buyers taking their own affiliate link, where the creator lets them.
 *
 * Measured before it was built (30 September 2026): Stan's Affiliate Share
 * makes every customer an affiliate on its $99 plan; Skool lets members refer
 * on its $99 plan; Teachable has student referrals. Here it is a switch on
 * every plan. What is checked:
 *
 *   - the order is the proof: only a settled checkout of this store, read
 *     back from the creator's Stripe account, lets anybody in, and the
 *     address that paid is the one that joins;
 *   - it is off until the creator switches it on;
 *   - somebody the creator declined stays out, and somebody waiting for a
 *     decision is let in;
 *   - the creator cannot join their own programme this way;
 *   - the purchase email offers the link only where it works.
 */
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { affiliateForSession, decide, joinAsBuyer, listAffiliates } from "@/lib/affiliates";
import { NextRequest } from "next/server";
import { POST as joinRoute } from "@/app/api/store/affiliates/join/route";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { confirmationFor } from "@/lib/purchase-email";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sessions = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const m = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  const found = m ? sessions.get(m[1]) : undefined;
  return new Response(JSON.stringify(found ?? { error: { message: "No such checkout.session" } }), { status: found ? 200 : 404 });
}) as typeof fetch;

const paid = (id: string, email: string, store = "harbor", extra: Record<string, unknown> = {}) =>
  sessions.set(id, {
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 2700,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
    customer_details: { email },
    metadata: { store, product: "p8w2m4q9zz" },
    ...extra,
  });

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_buyers_only_a_stand_in";
  redis.clear();
  const made = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  const load = async () => {
    const s = await storeForEmail("owner@example.com");
    if (!s) throw new Error("no store");
    return s;
  };

  paid("cs_test_dana000000001", "Dana@Example.com");
  paid("cs_test_other00000001", "eli@example.com", "someoneelse");
  paid("cs_test_unpaid0000001", "fay@example.com", "harbor", { payment_status: "unpaid", status: "open" });
  paid("cs_test_owner00000001", "owner@example.com");
  paid("cs_test_gus000000001", "gus@example.com");
  paid("cs_test_hal000000001", "hal@example.com");

  part("Off until the creator switches it on");
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, rates: {} });
  let store = await load();
  is("an order opens nothing while it is off", (await joinAsBuyer(store, "cs_test_dana000000001")).ok, false);
  is("the setting reads off by default", parseAffiliateSetting({ enabled: true }).buyers, false);

  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, buyers: true, rates: {} });
  store = await load();

  part("The order is the proof");
  const dana = await joinAsBuyer(store, "cs_test_dana000000001");
  if (!dana.ok) throw new Error(`Dana could not join: ${dana.reason}`);
  is("a buyer joins at once, approved", dana.affiliate.status, "approved");
  is("as the address that paid", dana.affiliate.email, "dana@example.com");
  is("and this browser is signed in as them", (await affiliateForSession(store, dana.session))?.id, dana.affiliate.id);
  const again = await joinAsBuyer(store, "cs_test_dana000000001");
  is("the same order twice is the same affiliate", again.ok && again.affiliate.id, dana.affiliate.id);
  is("and nobody is made twice", (await listAffiliates(store)).length, 1);
  const refuse = async (id: string) => {
    const r = await joinAsBuyer(store, id);
    return r.ok ? "joined" : r.reason;
  };
  is("another store's order does not open this one", await refuse("cs_test_other00000001"), "order");
  is("an unpaid checkout opens nothing", await refuse("cs_test_unpaid0000001"), "order");
  is("an order Stripe does not know opens nothing", await refuse("cs_test_nobody0000001"), "order");
  is("nor does something that is not an order id", await refuse("hello"), "order");
  is("the creator is never their own affiliate", await refuse("cs_test_owner00000001"), "owner");

  part("The creator's decisions stand");
  // Ivy applied the ordinary way and is still waiting for the creator.
  const statsId = store.statsId as string;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, "0123456789ab", JSON.stringify({ id: "0123456789ab", email: "ivy@example.com", code: "ivy", status: "pending", appliedAt: 1, decidedAt: 0, note: "" })],
    ["HSET", `nl:aff:${statsId}:emails`, "ivy@example.com", "0123456789ab"],
  ]);
  paid("cs_test_ivy000000001", "ivy@example.com");
  const ivy = await joinAsBuyer(store, "cs_test_ivy000000001");
  is("somebody waiting on an application is let in, as themselves", ivy.ok && [ivy.affiliate.id, ivy.affiliate.status], ["0123456789ab", "approved"]);
  const gusFirst = await joinAsBuyer(store, "cs_test_gus000000001");
  if (!gusFirst.ok) throw new Error("no gus");
  await decide(store, gusFirst.affiliate.id, "decline");
  is("somebody the creator declined stays out", await refuse("cs_test_gus000000001"), "declined");
  const hal = await joinAsBuyer(store, "cs_test_hal000000001");
  if (!hal.ok) throw new Error("no hal");
  await decide(store, hal.affiliate.id, "remove");
  is("and so does somebody they removed", await refuse("cs_test_hal000000001"), "declined");

  part("The same inbox written another way waits for the creator (624 [SZ8](35))");
  paid("cs_test_gusplus000001", "gus+shop@example.com");
  const gusTag = await joinAsBuyer(store, "cs_test_gusplus000001");
  is("declined gus, buying as gus+shop: an application that waits, not a link", gusTag.ok && [gusTag.affiliate.status, gusTag.created], ["pending", true]);
  paid("cs_test_haldot0000001", "Hal@Example.com.");
  const halDot = await joinAsBuyer(store, "cs_test_haldot0000001");
  is("removed hal, buying with a trailing dot on the domain: waits too", halDot.ok && halDot.affiliate.status, "pending");
  const halAgain = await joinAsBuyer(store, "cs_test_haldot0000001");
  is("and buying again does not approve the waiting one", halAgain.ok && halAgain.affiliate.status, "pending");
  // Jo applied the ordinary way as jo+news, and the creator declined jo; jo+news then buys.
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, "abcdefabcdef", JSON.stringify({ id: "abcdefabcdef", email: "jo@example.com", code: "jo", status: "declined", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${statsId}:emails`, "jo@example.com", "abcdefabcdef"],
    ["HSET", `nl:aff:${statsId}:people`, "fedcbafedcba", JSON.stringify({ id: "fedcbafedcba", email: "jo+news@example.com", code: "jonews", status: "pending", appliedAt: 3, decidedAt: 0, note: "" })],
    ["HSET", `nl:aff:${statsId}:emails`, "jo+news@example.com", "fedcbafedcba"],
  ]);
  paid("cs_test_jonews000001", "jo+news@example.com");
  const jo = await joinAsBuyer(store, "cs_test_jonews000001");
  is("somebody waiting whose inbox the creator declined is not approved by buying", jo.ok && [jo.affiliate.id, jo.affiliate.status], ["fedcbafedcba", "pending"]);
  paid("cs_test_owntag000001", "owner+shop@example.com");
  is("the creator under a + tag is still the creator", await refuse("cs_test_owntag000001"), "owner");
  paid("cs_test_kim000000001", "kim@example.com");
  const kim = await joinAsBuyer(store, "cs_test_kim000000001");
  is("an unrelated buyer still joins at once", kim.ok && kim.affiliate.status, "approved");
  const viaRoute = async (order: string) => {
    const form = new FormData();
    form.set("handle", "harbor");
    form.set("order", order);
    const response = await joinRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/join", { method: "POST", headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com" }, body: form }));
    return response.headers.get("location") ?? `status ${response.status}`;
  };
  is("the page then says the application is in, not that a link is ready", await viaRoute("cs_test_gusplus000001"), "https://marktmorgen.com/@harbor/affiliates?status=applied");
  is("and a buyer let in hears their link is ready", await viaRoute("cs_test_kim000000001"), "https://marktmorgen.com/@harbor/affiliates?status=joined");

  part("The purchase email offers it only where it works");
  const session = { ...sessions.get("cs_test_dana000000001")!, metadata: { store: "harbor", product: "p8w2m4q9zz" } };
  const listing = [{ id: "p8w2m4q9zz", title: "Pantry Guide", priceCents: 2700, options: [], recurring: null, call: null, course: null }] as never;
  const on = confirmationFor(store, session as never, Date.now() / 1000, [], listing);
  is("on: the email carries the way in", on?.text.includes("/@harbor/affiliates?order=cs_test_dana000000001") ?? false, true);
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, buyers: false, rates: {} });
  const off = confirmationFor(await load(), session as never, Date.now() / 1000, [], listing);
  is("off: it says nothing about it", off?.text.includes("affiliates?order=") ?? true, false);

  done();
}

void main();
