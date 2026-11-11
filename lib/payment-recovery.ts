/**
 * Telling a member, once, that their renewal did not go through — with a link
 * that actually recovers it.
 *
 * Nobody tells them otherwise. Stripe retries a failed card on its own
 * schedule, and it can email the member itself, but only if the creator has
 * found and switched on that setting in their own Stripe dashboard, which
 * most never do. So a member whose card expired is quietly retried against
 * the same dead card for two weeks and then cut off, never having been asked
 * for a new one. That is a member lost who never chose to leave.
 *
 * The link is the part that was easy to get wrong, and checked against
 * Stripe's own documentation before anything was written:
 *
 *   - Stripe retries a subscription on its OWN default card first, before the
 *     customer's. The portal's "update card" flow changes only the
 *     customer's. So a member who updated their card there would watch Stripe
 *     go on retrying the dead one — a fix that fixes nothing.
 *   - The invoice's own hosted page pays that very invoice, now, with
 *     whatever card is typed. It is Stripe's page and Stripe's checkout.
 *   - A subscription with `payment_settings.save_default_payment_method` set
 *     to `on_subscription` makes whatever card pays an invoice its new
 *     default, per Stripe's documentation. So that is set first.
 *
 * Together: the money that failed is paid, and the next renewal uses the card
 * that worked. Nothing depends on which default Checkout happened to set.
 *
 * Once per invoice, unless the creator chooses more (added 12 October 2026,
 * lib/dunning-rules.ts): two or three emails, the later ones 3 and 7 days
 * after the first, each only while that same payment is still unpaid. Once
 * is the default because a second and third email about the same payment can
 * read as a debt collector; a creator who knows their members chooses.
 *
 * And before a payment fails at all: when the card a membership is paid with
 * stops working before its next payment, the member is told some days ahead,
 * once per card, with a page that puts a new card on that membership
 * (lib/card-update.ts). On unless the creator switches it off.
 *
 * Checked in the daily job rather than as it happens, because this app
 * receives no events from Stripe — it asks, as every other sweep here does. A
 * member hears within a day of the failure, and nothing needs setting up in
 * anybody's Stripe dashboard for it to work.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { onAccount, platformKey } from "@/lib/stripe-account";
import { isSenderConfigured, sendEmail } from "@/lib/email";
import { formatMoney } from "@/lib/money";
import { fromStore, storeBase } from "@/lib/purchase-email";
import { readListings } from "@/lib/catalog";
import { type Store, saleHandles, storesAfter } from "@/lib/store";
import { sellsMemberships } from "@/lib/membership-manage";
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";
import { membershipWords } from "@/lib/buyer-words/membership";
import { CARD_NOTICE_DAYS, cardNoticeDue, reminderDue } from "@/lib/dunning-rules";
import { cardLink, finishCardUpdate, openKey } from "@/lib/card-update";
import { countSent, sentKey } from "@/lib/dunning-keys";

const CURSOR_KEY = "nl:dun:cursor";
const stepKey = (account: string, invoice: string, step: number) => `${sentKey(account, invoice)}:${step}`;
/** One card notice per membership and card. */
const cardKey = (account: string, sub: string, card: string) => `nl:dun:card:${account}:${sub}:${card}`;
const CARD_SENT_SECONDS = 400 * 86_400;
/** Where the card reading of a store stopped, so the next day goes on from there. */
const cardCursorKey = (account: string) => `nl:dun:cards:${account}`;
/** Where a store's past-due memberships were read to, so a list longer than one run reads is read through (R1 on #3215). */
const dueCursorKey = (account: string) => `nl:dun:due:${account}`;
/** Pages of 100 running memberships read for cards per store per run. */
const CARD_PAGES = 5;
/** Cards looked up one by one, for memberships paid with the customer's card rather than their own. */
const CARD_LOOKUPS = 20;
const SENT_SECONDS = 90 * 86_400;
/**
 * At most this many failed renewals written about per store per run (Claude 3 on #2714): each is a claim, a card
 * kept at Stripe and an email. Every page is read to decide, but no more than this is written in one run, as when
 * only the first page was read; the rest wait for the next run.
 */
const PER_STORE = 100;
/** Pages of past-due memberships read in one run, PER_STORE each: read to decide, not a larger number written. */
const FAILED_PAGES = 5;
/**
 * A store not finished in a run (its sweep threw, or it still had members to write to when the run stopped) is where
 * the next run starts, so they are not left until the walk has gone round every store (rule 24, R24 crons item 6). At
 * most this many runs in a row on the same store: one that keeps failing never holds every other store back, and is
 * read again on the next walk round.
 */
const HOLD_RUNS = 3;

/** What a store's sweep did: the emails sent, and whether everything it read was handled (false: more to do). */
type Swept = { sent: number; complete: boolean };

const INVOICE_PATTERN = /^in_[A-Za-z0-9]{6,64}$/;
const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;

type Sub = {
  id?: unknown;
  status?: unknown;
  metadata?: Record<string, string> | null;
  customer?: { email?: unknown; deleted?: unknown } | string | null;
  latest_invoice?: {
    id?: unknown;
    status?: unknown;
    amount_due?: unknown;
    currency?: unknown;
    hosted_invoice_url?: unknown;
    next_payment_attempt?: unknown;
  } | string | null;
};

/** What the email says, and nothing else: pure, so it can be read before it is sent. */
export function failedPaymentEmail(input: {
  storeName: string;
  /** The product's name, or null when the store no longer has it. */
  title: string | null;
  amount: string;
  payUrl: string;
  manageUrl: string;
  isPlan: boolean;
  /**
   * When Stripe will next try the card on file, as the member should read it
   * ("October 3"), or null when no retry is scheduled. Taken from the invoice
   * itself, because whether Stripe retries at all is a setting on the
   * creator's own account: "it will be tried again" is only written when it
   * will be.
   */
  nextTry: string | null;
  /** The store's language (lib/store-language.ts); English when left out. */
  language?: LanguageCode;
  /** The second or third email about the same payment: says so, first. */
  reminder?: boolean;
}): { subject: string; text: string } {
  const m = membershipWords(input.language);
  // "for The Inner Circle" reads right whatever the product is called. The
  // first draft said "your The Inner Circle Membership membership" for one
  // title and "your your membership" for none.
  return {
    subject: (input.reminder ? m.reminderSubject(input.storeName) : m.failedSubject(input.storeName)).slice(0, 200),
    text: [
      m.hi,
      "",
      ...(input.reminder ? [m.reminderLead, ""] : []),
      input.title ? m.failedFor(input.amount, input.title) : m.failedTo(input.amount, input.storeName),
      "",
      m.payHere,
      input.payUrl,
      "",
      m.cardKept,
      "",
      input.nextTry
        ? input.isPlan
          ? m.triedAgainPlan(input.nextTry)
          : m.triedAgain(input.nextTry)
        : m.notTriedAgain,
      "",
      input.isPlan ? m.receiptsPlan(input.manageUrl) : m.cancelInstead(input.manageUrl),
      "",
      `— ${input.storeName}`,
    ].join("\n"),
  };
}

/** The email before a card stops working. Pure, like the one above. */
export function cardNoticeEmail(input: {
  storeName: string;
  title: string | null;
  /** "Visa ending in 4242", as cardName words it. */
  card: string;
  /** The day of the next payment, in words: "November 3". */
  date: string;
  cardUrl: string;
  manageUrl: string;
  isPlan: boolean;
  language?: LanguageCode;
}): { subject: string; text: string } {
  const m = membershipWords(input.language);
  return {
    subject: m.cardSubject(input.storeName).slice(0, 200),
    text: [
      m.hi,
      "",
      input.title ? m.cardFor(input.card, input.title, input.date) : m.cardTo(input.card, input.storeName, input.date),
      "",
      m.cardHere,
      input.cardUrl,
      "",
      m.cardHow,
      "",
      m.cardBank,
      "",
      input.isPlan ? m.receiptsPlan(input.manageUrl) : m.cancelInstead(input.manageUrl),
      "",
      `— ${input.storeName}`,
    ].join("\n"),
  };
}

/** Whether a store can be asked about failed renewals at all. */
function worthAsking(store: Store): boolean {
  return Boolean(store.stripeAccountId) && sellsMemberships(store) && isSenderConfigured();
}

/**
 * One store's failed renewals, each written about once.
 *
 * A payment plan is included: an instalment that failed is money the buyer
 * agreed to, for something already handed over, and recovering it is as fair
 * as recovering a membership.
 */
async function remindFailed(store: Store, deadline: number): Promise<Swept> {
  const account = store.stripeAccountId as string;
  const handles = saleHandles(store);
  const query = new URLSearchParams({ status: "past_due", limit: String(PER_STORE) });
  query.append("expand[]", "data.latest_invoice");
  query.append("expand[]", "data.customer");
  // Every past-due membership, page after page while there is time (CX-123 rule 24, L6): a page that is not a list
  // stops this store's run, said as failed, never read as "nobody is behind".
  // From where the last run stopped (R1 on #3215): a list longer than FAILED_PAGES pages is read through across runs,
  // never its first pages again and again. A cursor not read as one is the top: read again, never skipped.
  const [saved] = await redisPipeline([["GET", dueCursorKey(account)]]);
  let after = typeof saved === "string" && SUB_PATTERN.test(saved) ? saved : "";
  const start = after;
  const subs: Sub[] = [];
  // Where a reading starts to list each membership again: the one listed just before it.
  const fromOf = new Map<Sub, string>();
  let pages = 0;
  let ended = false;
  for (; pages < FAILED_PAGES && Date.now() < deadline; pages += 1) {
    if (after) query.set("starting_after", after);
    const listed = (await onAccount("GET", account, `/subscriptions?${query}`)) as { data?: unknown; has_more?: unknown };
    if (!Array.isArray(listed.data) || (listed.has_more !== true && listed.has_more !== false)) throw new UnknownReplyError("a page of past-due memberships");
    let previous = after;
    for (const sub of listed.data as Sub[]) {
      fromOf.set(sub, previous);
      if (typeof sub?.id === "string" && SUB_PATTERN.test(sub.id)) previous = sub.id;
    }
    subs.push(...(listed.data as Sub[]));
    const last = (listed.data as Sub[]).at(-1)?.id;
    if (listed.has_more === false || typeof last !== "string" || !SUB_PATTERN.test(last)) {
      ended = true;
      break;
    }
    after = last;
  }
  // Stopped by the run's time, not by the end of the list or the page cap: there is more to read (rule 24, R24 crons
  // item 6). The page cap is not "more to do" now: the next run reads on from where this one stopped.
  let complete = ended || pages >= FAILED_PAGES;
  // Every member not handled, in list order, by where a reading starts to list it again.
  const notHandledFrom: string[] = [];
  const notHandled = (sub: Sub) => {
    complete = false;
    notHandledFrom.push(fromOf.get(sub) ?? start);
  };
  // Written once the members read are handled, never before (rule 24): a run that throws on the way leaves the cursor
  // where it was. The list ended: the top, so a member not handled is read again there, with every newer one.
  // Otherwise from before the first member not handled, but not when that is where this run started (nothing moved,
  // so a member that fails every time would hold the cursor for good): then from the next one not handled, or from
  // where this run stopped, and that member is read again when the list comes round.
  const moveCursor = async () => {
    const stopAt = notHandledFrom[0] ?? null;
    if (!ended && stopAt !== null && stopAt === start) console.error("failed renewals: a member at the start of this run was not handled again; the walk goes on and reads it when the list comes round", store.handle);
    const to = ended ? "" : stopAt === null ? after : stopAt === start ? (notHandledFrom[1] ?? after) : stopAt;
    await redisPipeline([to ? ["SET", dueCursorKey(account), to, "EX", 30 * 86_400] : ["DEL", dueCursorKey(account)]]);
  };
  const mine = subs.filter((s) => handles.has(s.metadata?.store ?? ""));
  if (!mine.length) {
    await moveCursor();
    return { sent: 0, complete };
  }

  const ids = [...new Set(mine.map((s) => s.metadata?.product ?? "").filter(Boolean))];
  const titles = new Map((await readListings(store, ids).catch(() => [])).map((p) => [p.id, p.title]));
  let sent = 0;
  let written = 0;

  for (const sub of mine) {
    // Members left for the next run, which starts at this store (recoverFailedPayments).
    if (Date.now() >= deadline || written >= PER_STORE) {
      for (const left of mine.slice(mine.indexOf(sub))) notHandled(left);
      break;
    }
    const subId = typeof sub.id === "string" && SUB_PATTERN.test(sub.id) ? sub.id : "";
    const invoice = sub.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
    const invoiceId = typeof invoice?.id === "string" && INVOICE_PATTERN.test(invoice.id) ? invoice.id : "";
    const payUrl = typeof invoice?.hosted_invoice_url === "string" ? invoice.hosted_invoice_url : "";
    const amount = typeof invoice?.amount_due === "number" ? invoice.amount_due : 0;
    const customer = sub.customer && typeof sub.customer === "object" ? sub.customer : null;
    const to = typeof customer?.email === "string" ? customer.email.trim() : "";
    // Only an invoice still open, with money on it, a page to pay it on and an
    // address to write to. Anything else is Stripe's to settle, not ours.
    if (!subId || !invoiceId || invoice?.status !== "open" || amount <= 0 || !payUrl.startsWith("https://") || !to) continue;

    // Which email is due: the first, or a later one the creator chose, on
    // its day. A first email from before reminders existed holds "1", not a
    // time, and is left as the only one.
    // Read exactly (CX-123 rule 24, L6): three answers, the first mark absent (nil) or text, each later one 0 or 1.
    // Anything else is unknown and no email is chosen on it this run.
    const marks = repliesFor(await redisPipeline([
      ["GET", sentKey(account, invoiceId)],
      ["EXISTS", stepKey(account, invoiceId, 2)],
      ["EXISTS", stepKey(account, invoiceId, 3)],
    ]), 3);
    if (!marks) {
      notHandled(sub);
      continue;
    }
    const [first] = marks;
    const second = countOf(marks[1]);
    const third = countOf(marks[2]);
    if ((first !== null && typeof first !== "string") || second === null || third === null || second > 1 || third > 1) {
      notHandled(sub);
      continue;
    }
    let step = 0;
    if (first === null) step = 1;
    else {
      const firstAt = Number(first);
      if (Number.isFinite(firstAt) && firstAt > 1e12) step = reminderDue(store.dunning.reminders, firstAt, 1 + second + third, Date.now());
    }
    if (!step) continue;
    const key = step === 1 ? sentKey(account, invoiceId) : stepKey(account, invoiceId, step);

    // Claimed before anything is done, so a second run does not write twice: ours on OK or, answered in another
    // shape, when the key holds this claim's own value read back (Claude 4 on #2714). The value starts with the time,
    // which is what a later run reads the first email's day from. Somebody else's or unknown: nothing is done.
    // Accepted (Claude 4 LEVE A on #2714): a claim answered oddly whose read-back also fails stays as it may be ours,
    // so a later run can take it as the first email sent and send the reminder that follows; that is the cost of
    // never writing twice, and the member still gets the pay link in the reminder.
    const value = claimValue();
    const claimed = await claimMark(key, SENT_SECONDS, value);
    if (claimed === "taken") continue;
    if (claimed !== "ours") {
      notHandled(sub);
      continue;
    }
    written += 1;

    try {
      // First, so the card that pays becomes the one the next renewal uses.
      // Without this the email would get this payment in and leave the next
      // one to fail on the same dead card. Once is enough.
      if (step === 1) {
        await onAccount(
          "POST",
          account,
          `/subscriptions/${subId}`,
          new URLSearchParams({ "payment_settings[save_default_payment_method]": "on_subscription" }),
        );
      }
      const isPlan = sub.metadata?.kind === "plan";
      const language = parseLanguage(store.language);
      const locale = LANGUAGES[language].locale;
      const next = typeof invoice?.next_payment_attempt === "number" && invoice.next_payment_attempt > 0 ? invoice.next_payment_attempt : 0;
      const mail = failedPaymentEmail({
        storeName: store.name,
        title: titles.get(sub.metadata?.product ?? "") || null,
        amount: formatMoney(amount, typeof invoice?.currency === "string" ? invoice.currency : store.currency, locale),
        payUrl,
        manageUrl: `${storeBase(store)}/manage`,
        isPlan,
        // A date the member reads in words. Without the store's time zone to
        // hand, the day is the one it falls on in UTC, which is never more
        // than a day out and never claims an hour.
        nextTry: next
          ? new Date(next * 1000).toLocaleDateString(locale, { month: "long", day: "numeric", timeZone: "UTC" })
          : null,
        language,
        reminder: step > 1,
      });
      const ok = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
        from: fromStore(store),
        to,
        subject: mail.subject,
        text: mail.text,
        // A member with a question about their payment reaches the creator.
        replyTo: store.email,
        idempotencyKey: step === 1 ? `nimbus-dun:${account}:${invoiceId}` : `nimbus-dun:${account}:${invoiceId}:${step}`,
      });
      if (ok) {
        sent += 1;
        await countSent(store.statsId, "failed");
      } else {
        await releaseMark(key, value);
        notHandled(sub);
      }
    } catch (error) {
      // Let go, so the next run tries this one again rather than never: only our own claim (Revisor 1 on #2719).
      await releaseMark(key, value);
      notHandled(sub);
      console.error("writing about a failed renewal failed", store.handle, error);
    }
  }
  await moveCursor();
  return { sent, complete };
}

type Card = { id: string; brand: string; last4: string; expMonth: number; expYear: number };

function cardOf(raw: unknown): Card | null {
  if (!raw || typeof raw !== "object") return null;
  const pm = raw as { id?: unknown; type?: unknown; card?: { brand?: unknown; last4?: unknown; exp_month?: unknown; exp_year?: unknown } | null };
  if (typeof pm.id !== "string" || pm.type !== "card" || !pm.card) return null;
  const { brand, last4, exp_month, exp_year } = pm.card;
  if (typeof exp_month !== "number" || typeof exp_year !== "number" || typeof last4 !== "string" || !/^\d{4}$/.test(last4)) return null;
  return { id: pm.id, brand: typeof brand === "string" ? brand : "card", last4, expMonth: exp_month, expYear: exp_year };
}

/** "Visa", "Mastercard", "American Express": the network as people say it. */
const BRANDS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  cartes_bancaires: "Cartes Bancaires",
  eftpos_au: "eftpos",
  interac: "Interac",
};
export const brandName = (brand: string) => BRANDS[brand] ?? "Card";

type RunningSub = Sub & {
  cancel_at_period_end?: unknown;
  cancel_at?: unknown;
  pause_collection?: unknown;
  current_period_end?: unknown;
  items?: { data?: { current_period_end?: unknown }[] };
  default_payment_method?: unknown;
};

const nextPaymentOf = (sub: RunningSub): number => {
  const fromItem = sub.items?.data?.[0]?.current_period_end;
  if (typeof fromItem === "number") return fromItem;
  return typeof sub.current_period_end === "number" ? sub.current_period_end : 0;
};

/**
 * One store's running memberships whose card stops working before their next
 * payment, each member told once per card (lib/dunning-rules.ts). Read a few
 * pages a day, from where the last run stopped, so a store of any size is
 * read through within the days the notice is sent ahead.
 */
async function noticeCards(store: Store, deadline: number): Promise<Swept> {
  const account = store.stripeAccountId as string;
  const handles = saleHandles(store);
  const now = Date.now();
  const [saved] = await redisPipeline([["GET", cardCursorKey(account)]]);
  let after = typeof saved === "string" && SUB_PATTERN.test(saved) ? saved : "";
  const start = after;
  // The list was read to its end this run: the next run reads it from the top (below).
  let ended = false;
  // `from`: where a reading starts to list that member again, the membership listed just before it (rule 24, R24
  // crons item 6): the cursor is moved only past the members handled, never past one read and not yet told.
  const due: { sub: RunningSub; card: Card; customer: string; email: string; payAt: number; from: string }[] = [];
  let lookups = 0;

  for (let page = 0; page < CARD_PAGES && Date.now() < deadline; page += 1) {
    const query = new URLSearchParams({ status: "active", limit: "100" });
    query.append("expand[]", "data.default_payment_method");
    query.append("expand[]", "data.customer");
    if (after) query.set("starting_after", after);
    const listed = (await onAccount("GET", account, `/subscriptions?${query}`)) as { data?: unknown; has_more?: unknown };
    // A page that is not a list is not "no running memberships" (CX-123 rule 24, L6): the cursor is not moved.
    if (!Array.isArray(listed.data) || (listed.has_more !== true && listed.has_more !== false)) throw new UnknownReplyError("a page of running memberships");
    const rows = listed.data as RunningSub[];
    let previous = after;
    for (const sub of rows) {
      const from = previous;
      if (typeof sub.id === "string" && SUB_PATTERN.test(sub.id)) previous = sub.id;
      if (!handles.has(sub.metadata?.store ?? "")) continue;
      // Ending, or paused: no payment for a card to miss.
      if (sub.cancel_at_period_end === true || typeof sub.cancel_at === "number" || sub.pause_collection) continue;
      const payAt = nextPaymentOf(sub);
      const customer = sub.customer && typeof sub.customer === "object" ? sub.customer : null;
      const email = typeof customer?.email === "string" ? customer.email.trim() : "";
      const customerId = typeof (customer as { id?: unknown } | null)?.id === "string" ? String((customer as { id: string }).id) : "";
      if (!email || !customerId || !payAt || payAt * 1000 - now > CARD_NOTICE_DAYS * 86_400_000 || payAt * 1000 <= now) continue;
      let card = cardOf(sub.default_payment_method);
      if (!card && !sub.default_payment_method && lookups < CARD_LOOKUPS) {
        // Paid with the customer's own default card, not one of its own.
        const settings = (customer as { invoice_settings?: { default_payment_method?: unknown } | null }).invoice_settings;
        const id = typeof settings?.default_payment_method === "string" ? settings.default_payment_method : "";
        if (/^pm_[A-Za-z0-9]{6,64}$/.test(id)) {
          lookups += 1;
          card = cardOf(await onAccount("GET", account, `/payment_methods/${id}`).catch(() => null));
        }
      }
      if (card && cardNoticeDue(card, payAt, now)) due.push({ sub, card, customer: customerId, email, payAt, from });
    }
    const last = rows[rows.length - 1];
    if (listed.has_more !== true || !last || typeof last.id !== "string") {
      after = "";
      ended = true;
      break;
    }
    after = last.id;
  }
  // Written once the members read are handled, never before (rule 24, R24 crons item 6): a run that throws on the way
  // leaves the cursor where it was, and the members it read are read again.
  const moveCursor = async (to: string) => {
    await redisPipeline([to ? ["SET", cardCursorKey(account), to, "EX", 30 * 86_400] : ["DEL", cardCursorKey(account)]]);
  };
  if (!due.length) {
    await moveCursor(after);
    return { sent: 0, complete: true };
  }

  const ids = [...new Set(due.map((d) => d.sub.metadata?.product ?? "").filter(Boolean))];
  const titles = new Map((await readListings(store, ids).catch(() => [])).map((p) => [p.id, p.title]));
  const language = parseLanguage(store.language);
  const locale = LANGUAGES[language].locale;
  const m = membershipWords(language);
  let sent = 0;
  // Where the next run reads again from: before the first member read and not handled (time ran out, something could
  // not be read, the email did not go), or null when every one was.
  // Every member not handled, in list order, by where a reading starts to list it again.
  const notHandledFrom: string[] = [];
  const notHandled = (from: string) => {
    if (notHandledFrom[notHandledFrom.length - 1] !== from) notHandledFrom.push(from);
  };

  for (let dueIndex = 0; dueIndex < due.length; dueIndex += 1) {
    const { sub, card, customer, email, payAt, from } = due[dueIndex];
    if (Date.now() >= deadline) {
      notHandled(from);
      // If time ran out before this member was tried, keep the cursor moving to the next due member. When this
      // member is at the start of the walk, stepping past just it lets the other due members from the pages we
      // already read be handled on the next run; this one is read again when the list comes round.
      const next = due[dueIndex + 1];
      if (next) notHandled(next.from);
      break;
    }
    const subId = typeof sub.id === "string" && SUB_PATTERN.test(sub.id) ? sub.id : "";
    if (!subId) continue;
    // A member who saved a new card and closed the tab before Stripe sent
    // them back: their card is set now, and there is nothing to tell them.
    const open = repliesFor(await redisPipeline([["GET", openKey(account, subId)]]), 1);
    // Unknown whether a card update is waiting: no notice on a guess, and read again on the next run.
    if (!open || (open[0] !== null && typeof open[0] !== "string")) {
      notHandled(from);
      continue;
    }
    const pending = open[0];
    if (typeof pending === "string") {
      const finished = await finishCardUpdate(store, pending);
      if (finished === "updated" || finished === "paid" || finished === "declined") continue;
    }
    const key = cardKey(account, subId, card.id);
    const value = claimValue();
    const claimed = await claimMark(key, CARD_SENT_SECONDS, value);
    // Somebody else's: told already, or being told. Unknown: nothing on a guess, and read again on the next run.
    if (claimed === "taken") continue;
    if (claimed !== "ours") {
      notHandled(from);
      continue;
    }
    try {
      const token = await cardLink(account, customer, subId);
      const mail = cardNoticeEmail({
        storeName: store.name,
        title: titles.get(sub.metadata?.product ?? "") || null,
        card: m.cardName(brandName(card.brand), card.last4),
        date: new Date(payAt * 1000).toLocaleDateString(locale, { month: "long", day: "numeric", timeZone: "UTC" }),
        cardUrl: `${storeBase(store)}/manage/card?t=${token}`,
        manageUrl: `${storeBase(store)}/manage`,
        isPlan: sub.metadata?.kind === "plan",
        language,
      });
      const ok = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
        from: fromStore(store),
        to: email,
        subject: mail.subject,
        text: mail.text,
        replyTo: store.email,
        idempotencyKey: `nimbus-card:${account}:${subId}:${card.id}`,
      });
      if (ok) {
        sent += 1;
        await countSent(store.statsId, "cards");
      } else {
        await releaseMark(key, value);
        notHandled(from);
      }
    } catch (error) {
      await releaseMark(key, value);
      notHandled(from);
      console.error("writing about a card that stops working failed", store.handle, error);
    }
  }
  // Where the next run reads from. The list ended: the top, so a member not handled is read again there, with every
  // newer one. Otherwise from before the first member not handled, but not when that is where this run started:
  // nothing moved, so a member whose notice fails every time would hold the store's cursor for good, and every member
  // after it would never be read (Claude 2 and Codex S on #3215); the walk then goes on from the last page read, and
  // that member is read again when the list comes round.
  // Only that member is stepped past: the next one not handled, when there is one, is read again on the next run
  // (Claude 1 on #3215: a sender outage would otherwise skip every member the run read).
  const stopAt = notHandledFrom[0] ?? null;
  if (!ended && stopAt === start) console.error("card notices: a member at the start of this run was not handled again; the walk goes on and reads it when the list comes round", store.handle);
  await moveCursor(ended ? "" : stopAt === null ? after : stopAt === start ? (notHandledFrom[1] ?? after) : stopAt);
  return { sent, complete: stopAt === null };
}

/** A store's failed payments, then its cards about to stop working. */
async function sweepStore(store: Store, deadline: number): Promise<Swept> {
  const failed = await remindFailed(store, deadline);
  if (!store.dunning.cardNotice) return failed;
  // The cards not read this run are read on the next, which starts at this store.
  if (Date.now() >= deadline) return { sent: failed.sent, complete: false };
  const cards = await noticeCards(store, deadline);
  return { sent: failed.sent + cards.sent, complete: failed.complete && cards.complete };
}

/**
 * Walks the stores that sell memberships until the deadline, remembering where
 * it stopped, exactly as the checkout sweep does (lib/checkout-sweep.ts).
 */
export async function recoverFailedPayments(deadline: number): Promise<{ stores: number; sent: number }> {
  const counts = { stores: 0, sent: 0 };
  if (!isRedisConfigured() || !platformKey() || !isSenderConfigured()) return counts;

  const [saved] = await redisPipeline([["GET", CURSOR_KEY]]);
  // "cursor|done|held": where the walk stopped, and how many runs in a row it has started at that store (HOLD_RUNS).
  const [savedCursor, savedDone, savedHeld] = typeof saved === "string" ? saved.split("|") : ["0", "0", "0"];
  let cursor = /^\d+$/.test(savedCursor ?? "") ? savedCursor : "0";
  let skip = Number(savedDone) || 0;
  const start = { cursor, skip, held: /^\d+$/.test(savedHeld ?? "") ? Number(savedHeld) : 0 };
  // The first store not finished this run, where the next run starts (HOLD_RUNS), or null when none.
  let hold: string | null = null;
  // A run that did not start at the top comes round to it, and stops where it started: a store held near the end
  // of the walk never keeps the stores before it waiting (Claude 6 on #3215).
  const fromTop = start.cursor === "0" && start.skip === 0;
  let wrapped = false;

  while (Date.now() < deadline) {
    const { stores, next } = await storesAfter(cursor);
    let done = 0;
    for (const store of stores) {
      if (done < skip) {
        done += 1;
        continue;
      }
      // Come round to where this run started: the walk is whole.
      if (wrapped && cursor === start.cursor && done >= start.skip) break;
      if (Date.now() >= deadline) break;
      if (worthAsking(store)) {
        counts.stores += 1;
        // A sweep that threw is not done (rule 24, R24 crons item 6): only one that handled all it read is.
        let complete = false;
        try {
          const swept = await sweepStore(store, deadline);
          counts.sent += swept.sent;
          complete = swept.complete;
        } catch (error) {
          console.error("reading a store's failed renewals failed", store.handle, error);
        }
        if (!complete && hold === null) {
          const held = cursor === start.cursor && done === start.skip ? start.held + 1 : 1;
          if (held < HOLD_RUNS) hold = `${cursor}|${done}|${held}`;
          else console.error(`a store's failed renewals were not finished in ${HOLD_RUNS} runs in a row: read again on the next walk round`, store.handle);
        }
      }
      done += 1;
    }
    if (done < stores.length) {
      await redisPipeline([["SET", CURSOR_KEY, hold ?? `${cursor}|${done}`]]);
      return counts;
    }
    skip = 0;
    cursor = next;
    // The end of the walk: done when this run started at the top or came round already (the scan moved past its
    // start without meeting it); otherwise round to the top.
    if (next === "0") {
      if (fromTop || wrapped) break;
      wrapped = true;
    }
  }
  await redisPipeline([["SET", CURSOR_KEY, hold ?? `${cursor}|0`]]);
  return counts;
}
