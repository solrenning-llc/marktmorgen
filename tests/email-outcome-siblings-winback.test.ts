/**
 * The come-back offer (lib/winback-send.ts) under a sender whose answer is not
 * known (rule 30, a sibling of 283 [HG2] unit 1's sendEmailOutcome).
 *
 * A timeout, a server error or a network error after the request may have
 * reached the sender can mean the email went. The once-marks are then kept,
 * so the daily job never writes the same offer twice; only a certain refusal
 * lets them go. Stripe and the sender are played by a stand-in for `fetch`;
 * no real email is sent. Checked:
 *
 *   - a 500 from the sender: asked once over two runs, both marks kept, and
 *     the offer's link kept, since the email holding it may have arrived;
 *   - a thrown request (network error): the same;
 *   - a 422 (a certain refusal): the marks are let go and the next run asks
 *     again (control: unchanged behavior);
 *   - a plain yes: sent once, counted (control);
 *   - the email is taken from the store's figure before each request,
 *     the uncertain ones included.
 */
import {
  addProduct,
  claimHandle,
  ensureListId,
  ensureStatsId,
  setProductLink,
  setStripeAccount,
  setSubscription,
  setWinBack,
  storeForEmail,
} from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { allowanceUsed } from "@/lib/store-allowance";
import { sendWinBacks, winbacksSent } from "@/lib/winback-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const now = Date.now();
const nowS = Math.floor(now / 1000);
const ACCOUNT = "acct_1TestOutcome01";

/** Every recipient the sender was asked for, taken or not. */
const asked: string[] = [];
const taken: string[] = [];
/** How the sender answers one recipient, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();
const events: Record<string, unknown>[] = [];
const customers = new Map<string, string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const to = [(JSON.parse(String(init?.body)) as { to: string | string[] }).to].flat()[0] ?? "";
    asked.push(to);
    const answer = senderAnswers.get(to);
    if (answer) return answer();
    taken.push(to);
    return new Response(JSON.stringify({ id: `email_${taken.length}` }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") {
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    return answer({ object: "list", data: events.filter((e) => Number(e.created) >= gte && Number(e.created) <= lte), has_more: false });
  }
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) return answer({ id: customer[1], email: customers.get(customer[1]) ?? null });
  // Nobody has come back.
  if (path === "/subscriptions") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

function ended(id: string, customer: string, meta: Record<string, string>) {
  events.push({
    id: `evt_${id}`,
    type: "customer.subscription.deleted",
    created: nowS - 8 * DAY,
    data: { object: { id, customer, ended_at: nowS - 8 * DAY, metadata: meta, items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] } } },
  });
}

const askedOf = (email: string) => asked.filter((to) => to === email).length;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_outcome_winback_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();

  const OWNER = "owner@example.com";
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setWinBack(OWNER, { percent: 25, months: 1, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  const store = await storeForEmail(OWNER);
  if (!store?.listId || !store.statsId) throw new Error("no list");

  const people: [string, string, string][] = [
    ["sub_Una000000001", "cus_Una0000001", "una@example.com"],
    ["sub_Tom000000001", "cus_Tom0000001", "tom@example.com"],
    ["sub_Rex000000001", "cus_Rex0000001", "rex@example.com"],
    ["sub_Ola000000001", "cus_Ola0000001", "ola@example.com"],
  ];
  for (const [sub, customer, email] of people) {
    customers.set(customer, email);
    await upsertContact(store.listId, email, { agreed: true, explicit: true, source: "buyer" }, ROOM);
    ended(sub, customer, { store: "harbor", product: club.product.id });
  }
  senderAnswers.set("una@example.com", () => new Response(JSON.stringify({ message: "internal" }), { status: 500 }));
  senderAnswers.set("tom@example.com", () => {
    throw new TypeError("fetch failed: the connection was reset");
  });
  senderAnswers.set("rex@example.com", () => new Response(JSON.stringify({ message: "invalid recipient" }), { status: 422 }));

  part("The first run");
  const usedBefore = await allowanceUsed(store, "email");
  await sendWinBacks(Date.now() + 30_000, now);
  is("each of the four was asked for once", people.map(([, , email]) => askedOf(email)), [1, 1, 1, 1]);
  is("each request was taken from the store's figure first, the uncertain ones included", (await allowanceUsed(store, "email")) - usedBefore, 4);
  is("only the plain yes is counted as sent", await winbacksSent(store), 1);
  redis.advance(2_000); // a mark let go lapses within a second (lib/claim-mark.ts)

  part("An answer not known keeps the marks: the offer is never sent twice");
  const membershipMark = (sub: string) => redis.keys().includes(`nl:wb:${ACCOUNT}:${sub}`);
  const onceMarks = () => redis.keys().filter((k) => k.startsWith(`nl:wb:once:${store.statsId}:`)).length;
  const links = () => redis.keys().filter((k) => k.startsWith("nl:wb:link:")).length;
  is("a 500: the membership's mark is kept", membershipMark("sub_Una000000001"), true);
  is("a thrown request: the membership's mark is kept", membershipMark("sub_Tom000000001"), true);
  is("a certain refusal (422): its mark is let go", membershipMark("sub_Rex000000001"), false);
  is("once-marks kept for the plain yes and both uncertain sends, not the refusal", onceMarks(), 3);
  is("the links of the sent and the two uncertain emails stay valid; the refused one's is deleted", links(), 3);

  senderAnswers.clear();
  await sendWinBacks(Date.now() + 30_000, now);
  is("the next run does not ask again after a 500", askedOf("una@example.com"), 1);
  is("nor after a thrown request", askedOf("tom@example.com"), 1);
  is("a certain refusal is asked again on the next run", askedOf("rex@example.com"), 2);
  is("the plain yes is not asked again", askedOf("ola@example.com"), 1);
  is("now two sent", await winbacksSent(store), 2);

  done();
}

void main();
