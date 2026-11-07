/**
 * The two sequences that are worth having from the first day, written for the
 * creator and left switched off for them to read.
 *
 * A list earns most from the emails that go out because of something a person
 * did, not from the ones sent to everybody at once: Omnisend's report on 2025
 * (150,000 brands, 27 billion emails) has automated emails at 2% of what was
 * sent and 30% of what email sold, and the welcome and the abandoned checkout
 * between them making three quarters of those orders. The abandoned checkout
 * is a switch here already (lib/checkout-recovery.ts). The welcome, and the
 * note after a first purchase, were a blank form — and a blank form is where
 * most creators stop, so most stores had no sequence at all.
 *
 * So one press makes both:
 *
 *   Welcome                 when somebody joins the list: a hello, then the
 *                           store's first paid product two days later, then
 *                           one more word about it three days after that.
 *   After a first purchase  the first time somebody buys anything: a thank
 *                           you with where their orders are, and, when the
 *                           store sells more than one thing, the rest of it
 *                           a few days later.
 *
 * What they are, so that nothing is sent that the creator did not mean:
 *
 *   - Switched off. They are made as drafts of a sequence; nothing goes to
 *     anybody until the creator has opened one and switched it on.
 *   - Plain words filled in with the store's own name, products and links.
 *     No model writes them, so they cost nothing and say the same thing
 *     every time — and they claim nothing: no result, no number of buyers,
 *     no discount, no deadline. What is true of every store is all they say.
 *   - Only where there is no sequence yet for that moment. A store that has
 *     its own welcome is not given a second one to send beside it.
 *   - Ordinary sequences afterward (lib/flows.ts): edited, paused or deleted
 *     like any other, and counted in the same month of emails.
 */
import { readFlowListStrict } from "@/lib/flow-list";
import { type Flow, type FlowMeter, type FlowResult, saveFlow, writeFlowList } from "@/lib/flows";
import { idsOfKind, productIds, readCards } from "@/lib/catalog";
import { storeBase } from "@/lib/purchase-email";
import { productLink } from "@/lib/checkout-recovery";
import type { Store } from "@/lib/store";

export type Starter = "welcome" | "bought";

/** What the words are filled in with. */
export type StarterFacts = {
  /** The name the creator's emails are from. */
  fromName: string;
  /** The store's own address, and where a buyer finds what they bought. */
  storeLink: string;
  ordersLink: string;
  /** The first product sold for money, in the store's own order; null when it sells nothing yet. */
  product: { title: string; link: string } | null;
  /** How many products are sold for money. */
  paidCount: number;
};

type RawStep = { delayHours: number; subject: string; body: string };
export type RawStarter = { name: string; trigger: Flow["trigger"]; productId: null; active: false; starter: Starter; steps: RawStep[] };

const lines = (...parts: string[]) => parts.join("\n\n");

/** The welcome: one email for a store with nothing to sell yet, three once it has. */
export function welcomeSteps(f: StarterFacts): RawStep[] {
  const steps: RawStep[] = [
    {
      delayHours: 0,
      subject: "Welcome, and what to expect",
      body: lines(
        "Hi,",
        "Thank you for joining my list. I'm glad you're here.",
        "I'll write when I have something worth your time: new things I make, and notes that go with them.",
        `Everything I offer is in one place:\n${f.storeLink}`,
        "If you have a question, reply to this email. It comes to me.",
        f.fromName,
      ),
    },
  ];
  if (!f.product) return steps;
  steps.push(
    {
      delayHours: 48,
      subject: `A closer look at ${f.product.title}`,
      body: lines(
        "Hi,",
        `You joined my list a couple of days ago, so I wanted to show you ${f.product.title}.`,
        f.product.link,
        "The page says what is inside and what it costs. If you are not sure it fits what you need, reply and ask me. I would rather you buy the right thing than the wrong one.",
        f.fromName,
      ),
    },
    {
      delayHours: 120,
      subject: `Any questions about ${f.product.title}?`,
      body: lines(
        "Hi,",
        `One more note about ${f.product.title}, and then I'll leave it with you.`,
        "If something is holding you back, whether it suits your situation, what is included or how it is delivered, reply and tell me.",
        `Here is the page again:\n${f.product.link}`,
        f.fromName,
      ),
    },
  );
  return steps;
}

/** After a first purchase: a thank you, and the rest of the store when there is a rest. */
export function boughtSteps(f: StarterFacts): RawStep[] {
  const steps: RawStep[] = [
    {
      delayHours: 24,
      subject: "Thank you, and one thing before you start",
      body: lines(
        "Hi,",
        "Thank you for buying from me.",
        "One thing before you start: if anything did not arrive, will not open, or is not what you expected, reply to this email and I will sort it out.",
        `Everything you have bought from me is here:\n${f.ordersLink}`,
        f.fromName,
      ),
    },
  ];
  if (f.paidCount < 2) return steps;
  steps.push({
    delayHours: 120,
    subject: "The rest of what I make",
    body: lines(
      "Hi,",
      "I hope what you bought is proving useful.",
      `Since you asked to hear from me, here is the rest of what I make, in case something there is your next step:\n${f.storeLink}`,
      "No rush. It will be there when you want it.",
      f.fromName,
    ),
  });
  return steps;
}

/**
 * The sequences to make for a store, given the ones it has. One is made only
 * for a moment — joining, a first purchase — that no sequence starts on yet.
 */
export function starterFlows(facts: StarterFacts, have: Pick<Flow, "trigger">[]): RawStarter[] {
  const taken = new Set(have.map((f) => f.trigger));
  const out: RawStarter[] = [];
  if (!taken.has("joined")) {
    out.push({ name: "Welcome", trigger: "joined", productId: null, active: false, starter: "welcome", steps: welcomeSteps(facts) });
  }
  // Nothing sold for money means nobody can buy for the first time.
  if (!taken.has("bought") && facts.paidCount > 0) {
    out.push({ name: "After a first purchase", trigger: "bought", productId: null, active: false, starter: "bought", steps: boughtSteps(facts) });
  }
  return out;
}

/** Which of the two a store could still be given, for the studio to offer. */
export function missingStarters(have: Pick<Flow, "trigger">[], sellsSomething: boolean): Starter[] {
  const taken = new Set(have.map((f) => f.trigger));
  return [...(taken.has("joined") ? [] : ["welcome" as const]), ...(taken.has("bought") || !sellsSomething ? [] : ["bought" as const])];
}

/** Whether a store has a product, on the store, that is sold for money. From its own index; nothing is read. */
export function sellsSomething(store: Store): boolean {
  const hidden = new Set(idsOfKind(store, "hidden"));
  return idsOfKind(store, "paid").some((id) => !hidden.has(id));
}

export type StartersResult =
  | { ok: true; flows: Flow[]; made: Starter[] }
  | { ok: false; reason: "nothing" | Exclude<FlowResult, { ok: true }>["reason"] };

/** Makes the starter sequences this store does not have yet, switched off. */
export async function setUpStarters(store: Store, meter?: FlowMeter): Promise<StartersResult> {
  // From the studio: the studio requests what reading and writing the workflows moves takes (lib/flows.ts, FlowMeter).
  const flows = meter ? await meter.list(store.listId) : await readFlowListStrict(store.listId);
  // Sold for money and on the store: a draft product is not something to
  // send people to. The store's own order is the creator's own priority.
  const hidden = new Set(idsOfKind(store, "hidden"));
  const paid = new Set(idsOfKind(store, "paid").filter((id) => !hidden.has(id)));
  const first = productIds(store).find((id) => paid.has(id)) ?? null;
  // One command for the name; nothing is read when nothing is sold.
  const title = first ? ((await readCards(store)).get(first)?.title ?? null) : null;
  const base = storeBase(store);
  const raws = starterFlows(
    {
      fromName: store.mail?.fromName || store.name,
      storeLink: base,
      ordersLink: `${base}/orders`,
      product: first && title ? { title, link: productLink(store, first) } : null,
      paidCount: paid.size,
    },
    flows,
  );
  if (!raws.length) return { ok: false, reason: "nothing" };
  let latest = flows;
  for (const raw of raws) {
    // Checked by the one place that checks a sequence: the plan, the setup, ten at most; built on the list read
    // above, not read again.
    const saved = await saveFlow(store, raw, { meter, onto: latest, write: false });
    if (!saved.ok) return saved;
    latest = saved.flows;
  }
  // Every starter in one write, its room and studio requests taken first: refused, the list is left as it was,
  // as NOT_COUNTED says (7 November 2026: written one by one, a refusal between them left the first written).
  await writeFlowList(store, latest, meter);
  return { ok: true, flows: latest, made: raws.map((r) => r.starter) };
}
