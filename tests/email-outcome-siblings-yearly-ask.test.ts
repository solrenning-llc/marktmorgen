/**
 * The yearly offer to a monthly member (lib/yearly-ask.ts) under a sender
 * whose answer is not known (rule 30, a sibling of 283 [HG2] unit 1's
 * sendEmailOutcome).
 *
 * A timeout, a server error or a network error after the request may have
 * reached the sender can mean the email went, and so can a send that went
 * through but whose count could not be written. The once-per-membership
 * mark is then kept, so the daily job never writes twice; only a certain
 * refusal lets it go. Stripe and the sender are played by a stand-in for
 * `fetch`; no real email is sent. Checked:
 *
 *   - a 500 from the sender: asked once over two runs, its mark kept;
 *   - a thrown request (network error): the same;
 *   - a 422 (a certain refusal): the mark is let go and the next run asks
 *     again (control: unchanged behavior);
 *   - a plain yes: sent once, counted (control);
 *   - sent, then the month's count not written: the mark is kept, so the
 *     offer is not sent again;
 *   - the email is taken from the store's figure before each request, the
 *     uncertain ones included.
 */
import { askStore, yearlyAsksThisMonth } from "@/lib/yearly-ask";
import { upsertContact } from "@/lib/contacts";
import { allowanceUsed } from "@/lib/store-allowance";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setProductYearly, setStripeAccount, setSubscription, setYearlyAsk, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

/** Every recipient the sender was asked for, taken or not. */
const asked: string[] = [];
/** How the sender answers one recipient, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();
let subs: Record<string, unknown>[] = [];
let product = "";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    const to = [(JSON.parse(String(init?.body)) as { to: string | string[] }).to].flat()[0] ?? "";
    asked.push(to);
    const special = senderAnswers.get(to);
    if (special) return special();
    return json({ id: `email_${asked.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if ((init?.method ?? "GET") === "GET" && path === "/subscriptions") return json({ object: "list", data: subs, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** A monthly member for three months, paying the full price: the yearly offer fits. */
const member = (id: string, email: string) => ({
  id,
  status: "active",
  customer: { id: `cus_${id.slice(4)}`, email },
  created: NOW - 90 * DAY,
  start_date: NOW - 90 * DAY,
  trial_end: null,
  discount: null,
  discounts: [],
  pause_collection: null,
  metadata: { store: "harbor", product },
  items: { data: [{ id: `si_${id.slice(4)}`, quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } } }] },
});

const askedOf = (email: string) => asked.filter((to) => to === email).length;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_outcome_yearly_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();

  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestYearly0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("no product");
  product = made.product.id;
  await setProductLink(OWNER, product, "https://example.com/club");
  await setProductYearly(OWNER, product, { cents: 20000 });
  if (!(await setYearlyAsk(OWNER, { on: true, address: "1 Main St, Portland, OR 97201" })).ok) throw new Error("no yearly ask");
  const store = (await storeForEmail(OWNER))!;
  if (!store.listId || !store.statsId) throw new Error("no list");

  const people: [string, string][] = [
    ["sub_Una000000001", "una@example.com"],
    ["sub_Tom000000001", "tom@example.com"],
    ["sub_Rex000000001", "rex@example.com"],
    ["sub_Ola000000001", "ola@example.com"],
  ];
  subs = people.map(([id, email]) => member(id, email));
  for (const [, email] of [...people, ["", "cy@example.com"]]) {
    await upsertContact(store.listId, email, { agreed: true, explicit: true, source: "buyer", productId: product, title: "Supper Club" }, ROOM);
  }
  senderAnswers.set("una@example.com", () => answerOf(500));
  senderAnswers.set("tom@example.com", () => {
    throw new TypeError("fetch failed: the connection was reset");
  });
  senderAnswers.set("rex@example.com", () => answerOf(422));
  const mark = (sub: string) => redis.keys().includes(`nl:yearask:${store.statsId}:${sub}`);

  part("The first run");
  const usedBefore = await allowanceUsed(store, "email");
  await askStore(store, Date.now() + 20_000);
  is("each of the four was asked for once", people.map(([, email]) => askedOf(email)), [1, 1, 1, 1]);
  is("each request was taken from the store's figure first, the uncertain ones included", (await allowanceUsed(store, "email")) - usedBefore, 4);
  is("only the plain yes is counted as sent", await yearlyAsksThisMonth(store), 1);

  part("An answer not known keeps the mark: never twice");
  // The mark is what keeps the next run from writing again; the synthetic sender can also hold a repeated idempotency
  // key back (the same body), which the real providers do only for a while, so the marks are checked first.
  is("a 500: its mark is kept", mark("sub_Una000000001"), true);
  is("a thrown request: its mark is kept", mark("sub_Tom000000001"), true);
  is("a certain refusal (422): its mark is let go", mark("sub_Rex000000001"), false);
  is("the plain yes: its mark is kept", mark("sub_Ola000000001"), true);
  senderAnswers.clear();
  await askStore(store, Date.now() + 20_000);
  is("the next run does not ask again after a 500", askedOf("una@example.com"), 1);
  is("nor after a thrown request", askedOf("tom@example.com"), 1);
  is("a certain refusal is asked again on the next run", askedOf("rex@example.com"), 2);
  is("the plain yes is not asked again", askedOf("ola@example.com"), 1);
  is("now two sent", await yearlyAsksThisMonth(store), 2);

  part("Sent, then the month's count not written: the mark is kept");
  subs = [...subs, member("sub_Cy0000000001", "cy@example.com")];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some(([verb, key]) => verb === "INCR" && String(key).startsWith("nl:yearask:count:"))) throw new Error("synthetic: the count could not be written");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  await askStore(store, Date.now() + 20_000);
  redis.pipeline = pipeline;
  is("it was sent", askedOf("cy@example.com"), 1);
  is("its mark is kept", mark("sub_Cy0000000001"), true);
  await askStore(store, Date.now() + 20_000);
  is("the next run does not send it again", askedOf("cy@example.com"), 1);
  // The synthetic sender may answer a repeated idempotency key from its receipt without a new request, so a second
  // send would show here as a second count, not as a second ask.
  is("nor count it again (the lost count stays lost)", await yearlyAsksThisMonth(store), 2);

  done();
}

function answerOf(status: number): Response {
  return new Response(JSON.stringify({ message: status >= 500 ? "internal" : "invalid recipient" }), { status });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
