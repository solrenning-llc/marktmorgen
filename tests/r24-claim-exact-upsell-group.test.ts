/**
 * The marks that stand between a buyer and a second charge count only on
 * Redis's own "OK" (CX-123 rule 24, inventory item 3 and 4 of the writes,
 * 8 November 2026):
 *
 *   - an offer after paying (lib/upsell.ts, takeUpsell) is claimed with a
 *     SET NX before the order is admitted and the card is charged. A reply in
 *     another shape (nothing, an empty string, an object, a short reply) was
 *     taken as "claimed", so two presses of the button could both go on to
 *     the charge. Now the claim is read exactly (lib/claim-mark.ts): "OK" is
 *     ours, nil is somebody else's, anything else is read back, and when it is
 *     still unknown nothing is admitted, written or charged, and the buyer is
 *     told so and can press again;
 *   - a purchase for several people (lib/group-buy.ts, settleGroup) is
 *     settled under a `:settling` mark taken the same way. A reply in another
 *     shape went on to mark the group paid and send its receipt; now it throws
 *     UnknownReplyError, so the confirmation is tried again and nothing is
 *     settled on a mark nobody holds.
 *
 * Healthy controls: an "OK" claim charges once and settles once, a nil claim
 * charges and settles nothing, two presses at once charge once, and a reply in
 * another shape whose write did land (read back as this claim's own value) is
 * still ours. Synthetic data and stand-ins for Stripe and the sender only: no
 * real account, payment, buyer or email.
 */
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { newUpsellKey, readUpsell, takeUpsell } from "@/lib/upsell";
import { readGroup, settleGroup, startGroup } from "@/lib/group-buy";
import { UnknownReplyError } from "@/lib/redis-reply";
import { THANKS_WORDS } from "@/lib/buyer-words/thanks";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_r24_claim_exact";
// One of the synthetic sending keys the stand-in sender knows (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_groups_only";

const S = Math.floor(Date.now() / 1000);
let charged = 0;
let emails = 0;
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    emails += 1;
    return answer({ id: `email_r24claim${emails}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    charged += 1;
    return answer({
      id: `pi_TestClaimEx${String(charged).padStart(8, "0")}`, object: "payment_intent", status: "succeeded", created: S,
      amount: Number(body.get("amount")), currency: body.get("currency"),
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
    });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The replies that are not Redis's own "OK" or nil for a SET NX. `SHORT` stands for a reply with no slot at all. */
const SHORT = Symbol("short");
const ODD: [string, unknown][] = [
  ["no answer in its slot", undefined],
  ["an empty string", ""],
  ["an object", {}],
  ["a number", 1],
  ["a queued answer", "QUEUED"],
  ["a short reply", SHORT],
];

/**
 * Answers the one SET NX that `pick` names in the odd shape: "lost" without writing it, "landed" after writing it.
 * Every other command is the stand-in's own.
 */
async function oddClaim<T>(pick: (command: (string | number)[]) => boolean, reply: unknown, how: "lost" | "landed", run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "SET" && commands[0].includes("NX") && pick(commands[0])) {
      if (how === "landed") await original(commands);
      return reply === SHORT ? [] : [reply];
    }
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

async function offers() {
  redis.clear();
  const OWNER = "r24claim-offers@example.com";
  await claimHandle(OWNER, "r24claim", "Claims", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_TestR24Claim1", true);
  await setSubscription(OWNER, { customerId: "cus_R24Claim01", subscriptionId: "sub_R24Claim01", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Sourdough Course", "49");
  const extra = await add("Starter Kit Guide", "29");
  const saved = await setProductFunnel(OWNER, front, {
    steps: [{ id: "kit001", productId: extra, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }],
  });
  is("the funnel is accepted", saved.ok, true);
  const store = (await storeForEmail(OWNER))!;
  const browser = newUpsellKey();
  let order = 0;
  const newOrder = () => {
    order += 1;
    const id = `cs_test_r24claim${String(order).padStart(8, "0")}`;
    sessions[id] = {
      id, status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000) - 60, customer: "cus_TestBuyer01", currency: "usd",
      metadata: { store: "r24claim", product: front, upsell_key: browser.fingerprint }, customer_details: { email: "buyer@example.com" },
      payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01" } },
    };
    return id;
  };
  const press = (id: string) => takeUpsell({ store, session: id, secret: browser.secret, origin: "https://marktmorgen.com", step: "kit001", answer: "yes", consent: TEST_CONSENT });
  const theClaim = (id: string) => (command: (string | number)[]) => command[1] === `nl:upsell:${id}`;

  part("Offer after paying: healthy controls");
  {
    const id = newOrder();
    const before = charged;
    is("an OK claim: charged once", [(await press(id)).kind, charged - before], ["done", 1]);
    is("pressed again: nothing more is charged", [(await press(id)).kind, charged - before], ["done", 1]);
  }
  {
    const id = newOrder();
    const before = charged;
    const both = await Promise.all([press(id), press(id)]);
    is("two presses at once: charged once", [both.map((r) => r.kind).sort(), charged - before], [["done", "done"], 1]);
  }
  {
    const id = newOrder();
    const before = charged;
    const nil = await oddClaim(theClaim(id), null, "lost", () => press(id));
    is("a nil claim (somebody else's): nothing is charged, as before", [nil.kind, charged - before], ["done", 0]);
  }

  for (const [label, reply] of ODD) {
    part(`Offer after paying, the claim answered with ${label}`);
    const id = newOrder();
    const before = charged;
    const lost = await oddClaim(theClaim(id), reply, "lost", () => press(id));
    is(`${label}, not written: nothing is charged and the buyer is told to try again`, [lost.kind, charged - before], ["retry", 0]);
    is(`${label}, not written: no answer is kept, so the offer can be answered again`, await readUpsell(id), null);
    const again = await press(id);
    is(`${label}: pressed again with Redis answering as it should, charged once`, [again.kind, charged - before], ["done", 1]);

    const landedId = newOrder();
    const landedBefore = charged;
    const landed = await oddClaim(theClaim(landedId), reply, "landed", () => press(landedId));
    is(`${label}, but the write landed (read back as this claim's own): charged once`, [landed.kind, charged - landedBefore], ["done", 1]);
  }

  part("What the buyer reads when the claim could not be confirmed");
  is("in US English, honest: nothing charged, try again", THANKS_WORDS.en.upsellNotes.retry, "We could not confirm that offer just now, so nothing was charged for it. Press the button again in a moment.");
  is("in every store language", Object.values(THANKS_WORDS).every((w) => typeof w.upsellNotes.retry === "string" && w.upsellNotes.retry.length > 20), true);
  is("each its own words", new Set(Object.values(THANKS_WORDS).map((w) => w.upsellNotes.retry)).size, Object.keys(THANKS_WORDS).length);
}

async function groups() {
  redis.clear();
  const OWNER = "r24claim-groups@example.com";
  await claimHandle(OWNER, "r24grp", "Groups", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_TestR24Group1", true);
  await setSubscription(OWNER, { customerId: "cus_R24Group01", subscriptionId: "sub_R24Group01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Bread Class", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/class");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  let n = 0;
  const newGroup = async () => {
    n += 1;
    const started = await startGroup(store, product, "2");
    if (!started.ok) throw new Error("no purchase for several");
    const id = started.group.id;
    const session = {
      id: `cs_test_r24grp${String(n).padStart(10, "0")}`, created: S, amount_total: 9800, currency: "usd",
      payment_intent: `pi_TestR24Grp${String(n).padStart(6, "0")}`,
      metadata: { store: "r24grp", product: product.id, group: id, people: "2" },
      customer_details: { email: "buyer@example.com" },
    };
    const settle = () => settleGroup({ store, session, product, base: "https://marktmorgen.com/@r24grp", from: '"Groups" <hello@marktmorgen.com>' });
    return { id, settle };
  };
  const theMark = (id: string) => (command: (string | number)[]) => command[1] === `nl:grp:${id}:settling`;
  const failure = (run: () => Promise<unknown>) => run().then((value) => `resolved ${String(value)}`, (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`));

  part("Settling a purchase for several: healthy controls");
  {
    const { id, settle } = await newGroup();
    const before = emails;
    is("an OK mark: settled once, one receipt", [await settle(), Boolean((await readGroup(id))?.paid), emails - before], ["settled", true, 1]);
    is("settled again: already, nothing more sent", [await settle(), emails - before], ["already", 1]);
  }
  {
    const { id, settle } = await newGroup();
    const before = emails;
    const nil = await oddClaim(theMark(id), null, "lost", settle);
    is("a nil mark (another settling): already, nothing marked paid or sent", [nil, Boolean((await readGroup(id))?.paid), emails - before], ["already", false, 0]);
  }

  for (const [label, reply] of ODD) {
    part(`Settling a purchase for several, the mark answered with ${label}`);
    const { id, settle } = await newGroup();
    const before = emails;
    const lost = await oddClaim(theMark(id), reply, "lost", () => failure(settle));
    is(`${label}, not written: an unknown reply, tried again later`, lost, "unknown");
    is(`${label}, not written: not marked paid, no receipt`, [Boolean((await readGroup(id))?.paid), emails - before], [false, 0]);
    is(`${label}: tried again with Redis answering as it should, settled once`, [await settle(), emails - before], ["settled", 1]);

    const landed = await newGroup();
    const landedBefore = emails;
    const ours = await oddClaim(theMark(landed.id), reply, "landed", landed.settle);
    is(`${label}, but the write landed (read back as this mark's own): settled once`, [ours, emails - landedBefore], ["settled", 1]);
  }
}

async function main() {
  await offers();
  await groups();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
