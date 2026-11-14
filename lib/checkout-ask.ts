/**
 * The reminder a buyer asks for themselves.
 *
 * The reminder after an unpaid checkout (lib/checkout-recovery.ts) rested
 * entirely on Stripe's own consent box, and Stripe puts that box only on the
 * checkouts of businesses in the United States. A creator in Europe or Canada
 * could not have the reminder at all — and it is, with the welcome, the
 * automatic email a store earns most from. Stripe hands over the address of
 * somebody who left only when that box was checked, so for every other
 * account there was no address and no yes.
 *
 * So the yes is asked for where we can ask it: on the way back. A buyer who
 * leaves Stripe's checkout without paying lands on a page of the store that
 * says nothing was charged, links back to the product, and offers one thing —
 * "leave your email and get one reminder with the link, in about an hour."
 * Whoever types an address there has asked, in so many words, for exactly
 * the email they then get. That holds in every country, which is why it is
 * offered by every store with reminders on, a US one included: it reaches
 * the buyer who did not check Stripe's box and still pressed back.
 *
 * What it is not: a way to collect addresses. An ask is one email about one
 * product. It puts nobody on the creator's list and shows the creator no
 * address, and it leaves this queue within the hour — sent, or dropped
 * because they bought in the meantime. What stays afterward is only what
 * makes the stop link in that email work (lib/checkout-recovery.ts).
 *
 * What stands in front of it, since a public form that sends email is a
 * thing to be careful with:
 *
 *   - A few asks an hour from one connection, and a ceiling a day for one
 *     store, so the form cannot be turned on somebody's inbox or run up a
 *     bill. Past either, the page says so and nothing is kept.
 *   - Everything the other reminder checks (lib/checkout-recovery.ts,
 *     deliver): once per address and product in a week, never to an address
 *     that pressed stop or left the creator's list, never to somebody who has
 *     paid since, with the stop link and the creator's postal address.
 *   - The email itself says why it came: "you asked for it on this store".
 *     Somebody whose address was typed by another person gets one email,
 *     saying that, with a link that stops them for good.
 *
 * The same ask is offered on a product's own page (added 9 October 2026),
 * under the buy box, for the visitor who is not ready yet — reading on a
 * phone, buying later at a desk: one reminder with the link, in about an
 * hour, tomorrow or in three days (lib/ask-when.ts), with every rule above.
 * Its email says it was asked for on the page, not that a checkout was left.
 *
 * And for a whole cart (added 10 October 2026), on the way back from its
 * checkout: one reminder of what is in it, with a link that puts the cart
 * back as it was (lib/checkout-recovery.ts, cartLink).
 *
 *   nl:recover:asks     asks waiting, by when each is due (a sorted set)
 */
import { createHash } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withinEssentialLimit } from "@/lib/request-guard";
import { recoveryOn } from "@/lib/recovery-setting";
import { type RemindOutcome, remindAsked } from "@/lib/checkout-recovery";
import { REMINDER_RETRIES, reminderRetryAfter, retriesOf } from "@/lib/reminder-retry";
import { canSellProduct } from "@/lib/store-checkout";
import type { Listing, Store } from "@/lib/store";
import { ASK_WHENS, type AskWhen } from "@/lib/ask-when";
import { cartable } from "@/lib/cart-rules";
import { cartAskKey } from "@/lib/checkout-ask-cart";

/** How long after asking the reminder goes: the same hour the other one waits. */
export const ASK_AFTER_SECONDS = 60 * 60;
/** Asks from one connection in an hour. */
export const ASKS_PER_ADDRESS_HOUR = 3;
/**
 * Asks one store takes in a day. Each is at most one email, at $0.0009, so a
 * store's worst day is eighteen cents — and a form somebody is abusing stops
 * long before it matters to anybody's inbox.
 */
export const ASKS_PER_STORE_DAY = 200;
/** An ask not sent this long after it was due is dropped: the moment has gone. */
const STALE_SECONDS = 6 * 60 * 60;

const QUEUE = "nl:recover:asks";

export type AskOutcome =
  /** Kept, and a reminder goes in about an hour. */
  | "asked"
  | "email"
  | "limited"
  /** This store has no reminders, or this is not something that can be bought now. */
  | "closed";

/** Whether a product is one a reminder can be asked for at all. */
export function askable(store: Store, product: Listing | null): product is Listing {
  if (!product) return false;
  return recoveryOn(store) && !product.call && !product.hidden && canSellProduct(store, product);
}

/** Where it was asked for: on the way back from a checkout, or on the product's own page. */
export type AskFrom = "checkout" | "page";

/** `tries`: how many times it was put back after a send that failed (lib/reminder-retry.ts); absent when never. */
type Ask = { statsId: string; handle: string; productId: string; email: string; askedAt: number; from: AskFrom; after: number; tries?: number };

/** One ask as it waits in the queue. The address is here until it is sent and nowhere else. */
export function askMember(ask: Ask): string {
  const base = [ask.statsId, ask.handle, ask.productId, ask.email, ask.askedAt];
  // Put back after a failed send: the long shape, with the count of tries last.
  if (ask.tries) return JSON.stringify([...base, ask.from, ask.after, ask.tries]);
  // An ask from a checkout keeps the shape it always had, so one already waiting reads the same.
  return JSON.stringify(ask.from === "checkout" && ask.after === ASK_AFTER_SECONDS ? base : [...base, ask.from, ask.after]);
}

export function parseAsk(member: unknown): Ask | null {
  if (typeof member !== "string") return null;
  try {
    const [statsId, handle, productId, email, askedAt, from, after, tried] = JSON.parse(member) as unknown[];
    if (typeof statsId !== "string" || typeof handle !== "string" || typeof productId !== "string") return null;
    if (typeof email !== "string" || typeof askedAt !== "number" || !statsId || !handle || !productId || !email) return null;
    const wait = typeof after === "number" && (Object.values(ASK_WHENS) as number[]).includes(after) ? after : ASK_AFTER_SECONDS;
    const tries = retriesOf(tried);
    return { statsId, handle, productId, email, askedAt, from: from === "page" ? "page" : "checkout", after: wait, ...(tries ? { tries } : {}) };
  } catch {
    return null;
  }
}

/** What names one ask, so the same one is never sent twice. */
export const askKey = (ask: Pick<Ask, "statsId" | "productId" | "email" | "askedAt">) =>
  createHash("sha256").update(`nimbus-ask:${ask.statsId}|${ask.productId}|${normaliseEmail(ask.email)}|${ask.askedAt}`).digest("hex").slice(0, 32);

/**
 * Keeps an ask for a reminder of a whole cart, on the way back from its
 * checkout (lib/cart-checkout.ts): the products in it that can still go in
 * one, each checked by the caller. The same queue, limits and email rules.
 */
export async function askCartReminder(input: { store: Store; items: Listing[]; email: string; ip: string }): Promise<AskOutcome> {
  const { store } = input;
  const items = input.items.filter((product) => cartable(product) && canSellProduct(store, product));
  if (!isRedisConfigured() || !store.statsId || !recoveryOn(store) || items.length === 0) return "closed";
  return keep(store, cartAskKey(items.map((p) => p.id)), input.email, input.ip, "checkout", ASK_AFTER_SECONDS);
}

/** Keeps an ask for a reminder. Says what happened; never throws at the buyer. */
export async function askReminder(input: { store: Store; product: Listing | null; email: string; ip: string; from?: AskFrom; when?: AskWhen }): Promise<AskOutcome> {
  const { store, product } = input;
  if (!isRedisConfigured() || !store.statsId || !askable(store, product)) return "closed";
  const from = input.from ?? "checkout";
  const after = from === "page" && input.when ? ASK_WHENS[input.when] : ASK_AFTER_SECONDS;
  return keep(store, product.id, input.email, input.ip, from, after);
}

async function keep(store: Store, productId: string, typed: string, ip: string, from: AskFrom, after: number): Promise<AskOutcome> {
  const statsId = store.statsId as string;
  const email = normaliseEmail(typed);
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return "email";
  if (!(await withinEssentialLimit("remind-ask", ip, ASKS_PER_ADDRESS_HOUR, 3600))) return "limited";
  if (!(await withinEssentialLimit("remind-store", statsId, ASKS_PER_STORE_DAY, 86_400))) return "limited";
  const askedAt = Math.floor(Date.now() / 1000);
  await redisPipeline([
    ["ZADD", QUEUE, askedAt + after, askMember({ statsId, handle: store.handle, productId, email, askedAt, from, after })],
  ]);
  return "asked";
}

/**
 * Puts an ask whose send failed back in the queue, for a later try
 * (lib/reminder-retry.ts): a few times at the most, and never when the try
 * would land past its six hours — a reminder that arrives hours late is worse
 * than none, and the buyer can ask again. Its name (askKey) does not change,
 * so a try that does go is the one email. Whether it went back.
 */
async function again(ask: Ask, now: number): Promise<boolean> {
  const tries = ask.tries ?? 0;
  const at = now + reminderRetryAfter(tries);
  if (tries >= REMINDER_RETRIES || at - (ask.askedAt + ask.after) > STALE_SECONDS) return false;
  try {
    const [added] = await redisPipeline([["ZADD", QUEUE, at, askMember({ ...ask, tries: tries + 1 })]]);
    // 1 put back; 0 one just like it already waits. Anything else is unknown: not counted as put back.
    if (added === 1 || added === 0) return true;
    console.error("putting an asked-for reminder back answered in no known shape", ask.handle);
  } catch (error) {
    console.error("putting an asked-for reminder back failed", ask.handle, error);
  }
  return false;
}

/**
 * Sends every ask that is due. For the five-minute job. Each is taken off the
 * queue before anything is sent, so two runs never send the same one. One
 * that is no longer to be sent (another store at the handle, too late, paid
 * since, stopped) is dropped, and so is one the email service was asked for
 * and did not take; one that failed on the way, before the email service was
 * asked (an error reading the store or Stripe), is put back for a later try
 * (again).
 */
export async function sendAsked(
  load: (handle: string) => Promise<Store | null>,
  deadline: number,
): Promise<{ sent: number; skipped: number; retried: number }> {
  const counts = { sent: 0, skipped: 0, retried: 0 };
  if (!isRedisConfigured()) return counts;
  const now = Math.floor(Date.now() / 1000);
  const [due] = await redisPipeline([["ZRANGEBYSCORE", QUEUE, 0, now, "LIMIT", 0, 200]]);
  const members = Array.isArray(due) ? (due as string[]) : [];
  for (const member of members) {
    if (Date.now() >= deadline) break;
    const [taken] = await redisPipeline([["ZREM", QUEUE, member]]);
    if (Number(taken) !== 1) continue;
    const ask = parseAsk(member);
    if (!ask || now - (ask.askedAt + ask.after) > STALE_SECONDS) {
      counts.skipped += 1;
      continue;
    }
    // "retry": it failed on the way, before the email service was asked (lib/reminder-retry.ts).
    let outcome: RemindOutcome | "retry";
    try {
      const store = await load(ask.handle);
      // The store the ask was made on, and not another that has since taken its address.
      outcome =
        store && store.statsId === ask.statsId
          ? await remindAsked(store, { productId: ask.productId, email: ask.email, askedAt: ask.askedAt, key: askKey(ask), from: ask.from })
          : "skip";
    } catch (error) {
      console.error("sending an asked-for reminder failed", ask.handle, error);
      outcome = "retry";
    }
    if (outcome === "sent") counts.sent += 1;
    // "failed" is a send the email service was asked for and did not take: never again (lib/reminder-retry.ts).
    else if (outcome === "retry" && (await again(ask, now))) counts.retried += 1;
    else counts.skipped += 1;
  }
  return counts;
}
