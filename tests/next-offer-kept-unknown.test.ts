/**
 * The order's kept next-product choice (lib/next-offer.ts, readKept) read in
 * its exact shape (CX-123 rule 24). Only a confirmed absent key (GET null)
 * means "no choice made yet". Any other reply — a number, a list, an object,
 * a string that is not the kept record, or a pipeline answer with the wrong
 * number of replies — is unknown, and what depends on it refuses:
 *
 *   - the page after paying (nextOfferFor) does not choose again: no model
 *     call, no reply of the month's ASSISTANT_POOL spent, and the kept record
 *     (a buyer's "no thanks" included) is not overwritten;
 *   - the buyer's "no thanks" (dismissNextOffer) writes nothing;
 *   - the confirmation email (nextOfferForEmail) carries nothing.
 *
 * Controls: a kept record is shown as before, a dismissed one stays hidden,
 * and a confirmed absent key still makes the choice once. Stripe and the
 * model are played by a stand-in for `fetch`; synthetic data only.
 */
import { addProduct, claimHandle, ensureStatsId, setAssistantPlan, setNextOffer, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { assistantWindow } from "@/lib/store-assistant-rules";
import { dismissNextOffer, nextOfferFor, nextOfferForEmail } from "@/lib/next-offer";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_next_offer_kept_only";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";

const OWNER = "kept@example.com";
const ACCOUNT = "acct_fixture008";
const BUYER = "buyer.kept@example.com";

let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.anthropic.com") {
    modelCalls += 1;
    return answer({ content: [{ type: "text", text: JSON.stringify({ pick: 2, reason: "It cooks the dinners the planner plans." }) }], usage: { input_tokens: 1_500, output_tokens: 30 } });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const keptKey = (session: string) => `nl:assist:next:${session}`;
const lockKey = (session: string) => `nl:assist:nextlock:${session}`;
const rawKept = async (session: string) => (await redis.pipeline([["GET", keptKey(session)]]))[0];
const poolOf = async (statsId: string, id: string) => {
  const [raw] = await redis.pipeline([["HGETALL", `nl:assist:pool:${statsId}:${id}`]]);
  return JSON.stringify(raw);
};

/** Every GET of this session's kept record answers `reply` (the whole pipeline answer), the rest of Redis as it is. */
function keptAnswers(session: string, reply: () => unknown[]): () => void {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === keptKey(session)) return reply();
    return real(commands);
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = real as typeof redis.pipeline;
  };
}

/** A refusal is a throw or an empty answer; anything shown or done is not. */
async function settled<T>(work: () => Promise<T>): Promise<T | "threw"> {
  try {
    return await work();
  } catch {
    return "threw";
  }
}

let n = 0;
const session = () => `cs_test_keptunknown${String((n += 1)).padStart(6, "0")}`;

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  await claimHandle(OWNER, "keptshop", "Kept Shop", "Recipes for busy weeknights.");
  await setSubscription(OWNER, { customerId: "cus_KeptShop001", subscriptionId: "sub_KeptPlan01", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
  await setStripeAccount(OWNER, ACCOUNT, true);
  await ensureStatsId(OWNER);
  const make = async (title: string, summary: string, price: string) => {
    const made = await addProduct(OWNER, title, summary, price, null);
    if (!made.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const planner = await make("Meal Planner", "A week of dinners, planned.", "27");
  await make("Grocery Lists", "Printable lists for every week of the planner.", "9");
  await make("Batch Cooking Course", "Cook the planner's dinners in two hours on Sunday.", "49");
  await setNextOffer(OWNER, { on: true, email: true });
  const plan = { subscriptionId: "sub_KeptAsst02", active: true, period: paidPeriod(now), cancelsAtEnd: false, disputedAt: "" };
  await setAssistantPlan(OWNER, plan);
  const store = (await storeForEmail(OWNER))!;
  const window = assistantWindow(plan, now / 1000)!;
  const bought = [(await readListing(store, planner))!];
  const offerFor = (s: string) => nextOfferFor({ store, session: s, email: BUYER, bought, alsoOwned: [], declined: [], now });
  const meta = { news: "yes" };

  part("Controls: a confirmed absent key chooses once, a kept choice is shown, a dismissed one stays hidden");
  const kept = session();
  const first = await offerFor(kept);
  is("absent: the choice is made once, by the model, and kept", [Boolean(first), first?.ai, modelCalls], [true, true, 1]);
  const again = await offerFor(kept);
  is("kept: the same product again, nothing more asked", [again?.product.id, modelCalls], [first?.product.id, 1]);
  is("the email carries the kept choice", (await nextOfferForEmail(store, kept, meta))?.product.id, first?.product.id);
  const dismissed = session();
  await offerFor(dismissed);
  is("no thanks is kept", await dismissNextOffer(store, dismissed), true);
  is("and stays hidden on the page and in the email, with nothing asked", [await offerFor(dismissed), await nextOfferForEmail(store, dismissed, meta), modelCalls], [null, null, 2]);

  // The order's one-minute lock has run out: the page opened again would choose if it took the record for absent.
  redis.advance(61_000);
  const dismissedRaw = await rawKept(dismissed);
  const keptRaw = await rawKept(kept);

  const shapes: [string, () => unknown[]][] = [
    ["a number", () => [7]],
    ["a list", () => [[String(keptRaw)]]],
    ["an object", () => [{ s: store.statsId }]],
    ["true", () => [true]],
    ["an empty string", () => [""]],
    ["a string that is not JSON", () => ["{not json"]],
    ["JSON out of the record's shape", () => [JSON.stringify({ s: store.statsId, p: 5, r: "ai", w: "" })]],
    ["no reply at all", () => []],
    ["two replies for one command", () => [null, null]],
  ];
  for (const [name, reply] of shapes) {
    part(`Unknown kept record: ${name}`);
    // Each shape starts from the same dismissed order with no lock, so each one's own outcome is what is checked.
    await redis.pipeline([["SET", keptKey(dismissed), String(dismissedRaw), "EX", 3 * 86_400], ["DEL", lockKey(dismissed)]]);
    const poolBefore = await poolOf(store.statsId!, window.id);
    const callsBefore = modelCalls;
    const restore = keptAnswers(dismissed, reply);
    let page: unknown, email: unknown, dismiss: unknown;
    try {
      page = await settled(() => offerFor(dismissed));
      email = await settled(() => nextOfferForEmail(store, dismissed, meta));
      dismiss = await settled(() => dismissNextOffer(store, dismissed));
    } finally {
      restore();
    }
    is("the page refuses: nothing chosen or shown", page === "threw" || page === null, true);
    is("no model asked and no reply of the month's pool spent", [modelCalls - callsBefore, await poolOf(store.statsId!, window.id)], [0, poolBefore]);
    is("the buyer's no thanks is not overwritten", await rawKept(dismissed), dismissedRaw);
    is("the email carries nothing", email === "threw" || email === null, true);
    is("a dismissal on an unknown record does not say done", dismiss === "threw" || dismiss === false, true);
    is("no lock left behind to hide the order's real choice", (await redis.pipeline([["GET", lockKey(dismissed)]]))[0], null);
    is("and once Redis answers in shape again, the order is still dismissed", await offerFor(dismissed), null);
  }

  part("The healthy record is untouched by all of it");
  is("the kept order still shows its own choice, nothing more asked", [(await offerFor(kept))?.product.id, await rawKept(kept), modelCalls], [first?.product.id, keptRaw, 2]);
}

main()
  .then(done)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
