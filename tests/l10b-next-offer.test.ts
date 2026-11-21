/**
 * CX-123 rule 24, lot L10b: the next product after a purchase (lib/next-offer.ts) is chosen once an order, under a
 * one-minute lock taken with SET NX. A reply to it in any shape but "OK" or nil is read back: our own value is ours and
 * the choice is made; another value is another opening choosing now, and this one shows nothing; nothing readable
 * shows nothing now (the page opened again chooses). The lock is let go only while it holds our own value, so a run
 * whose lock ran out never deletes the lock of the run that took it next. Stripe is played by a stand-in for `fetch`.
 */
import { addProduct, claimHandle, ensureStatsId, setAssistantPlan, setNextOffer, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { nextOfferFor } from "@/lib/next-offer";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ODD, THROWS, UNREADABLE, answer, clearAnswers, count, getOf, setNx } from "./l10b-replies";

process.env.STRIPE_SECRET_KEY = "sk_test_l10b_next_offer_only";
const OWNER = "l10b-next@example.com";
const BUYER = "buyer@example.com";
const LOCK = "nl:assist:nextlock:";
const KEPT = "nl:assist:next:";

let stripeAsked = 0;
let stripeDown = false;
/** Run when Stripe is asked: another run taking the lock after this one's ran out. */
let onStripe: (() => void) | null = null;
globalThis.fetch = (async () => {
  stripeAsked += 1;
  onStripe?.();
  if (stripeDown) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

let n = 0;
const order = () => `cs_test_lnext${String((n += 1)).padStart(8, "0")}`;

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  await claimHandle(OWNER, "lnext", "Next Shop", "");
  await setSubscription(OWNER, { customerId: "cus_LnextShop01", subscriptionId: "sub_LnextPlan1", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
  await setStripeAccount(OWNER, "acct_1TestLnext0001", true);
  await ensureStatsId(OWNER);
  const make = async (title: string, price: string) => {
    const made = await addProduct(OWNER, title, `${title}, the summary.`, price, null);
    if (!made.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const planner = await make("Meal Planner", "27");
  await make("Grocery Lists", "9");
  await setNextOffer(OWNER, { on: true, email: true });
  await setAssistantPlan(OWNER, { subscriptionId: "sub_LnextAssist", active: true, period: paidPeriod(now), cancelsAtEnd: false, disputedAt: "" });
  const store = (await storeForEmail(OWNER))!;
  const bought = [(await readListing(store, planner))!];
  const ask = (session: string) => nextOfferFor({ store, session, email: BUYER, bought, alsoOwned: [], declined: [], now });

  part("The plain case: chosen once");
  clearAnswers();
  stripeAsked = 0;
  const plain = await ask(order());
  is("an offer, Stripe asked, the choice kept", [plain !== null, stripeAsked > 0, count("SET", KEPT)], [true, true, 1]);

  part("A lock held by another opening is never taken for ours");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    stripeAsked = 0;
    const s = order();
    redis.run(["SET", `${LOCK}${s}`, "1700000000000.000000001", "EX", 60]);
    answer(setNx(LOCK), reply);
    const got = await ask(s);
    is(`the lock answered with ${shape} while another holds it: nothing shown, nothing asked, nothing kept`, [got, stripeAsked, count("SET", KEPT)], [null, 0, 0]);
  }

  part("The lock written and its answer lost: our own value read back, chosen once");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const s = order();
    answer(setNx(LOCK), reply);
    const got = await ask(s);
    is(`answered with ${shape}, the write landed: chosen and kept`, [got !== null, count("SET", KEPT)], [true, 1]);
  }

  part("Nothing readable: nothing shown now");
  for (const [shape, reply] of [...UNREADABLE, ["the write failing too", THROWS] as const]) {
    clearAnswers();
    stripeAsked = 0;
    answer(setNx(LOCK), shape === "the write failing too" ? THROWS : () => ["QUEUED"], { run: false });
    answer(getOf(LOCK), reply);
    const got = await ask(order()).catch(() => "threw");
    is(`the lock unknown and its read-back ${shape}: nothing shown, nothing asked`, [got, stripeAsked, count("SET", KEPT)], [null, 0, 0]);
  }

  part("A lock that ran out and was taken by another run is not ours to let go");
  clearAnswers();
  const s = order();
  stripeDown = true;
  onStripe = () => {
    redis.run(["SET", `${LOCK}${s}`, "another-run", "EX", 60]);
  };
  is("what the buyer owns cannot be read: nothing shown", await ask(s), null);
  is("and the other run's lock is still there", redis.run(["GET", `${LOCK}${s}`]), "another-run");
  stripeDown = false;
  onStripe = null;
  const t = order();
  stripeDown = true;
  is("its own lock is let go when nothing can be read", [await ask(t), redis.run(["EXISTS", `${LOCK}${t}`])], [null, 0]);
  stripeDown = false;
  done();
}

void main();
