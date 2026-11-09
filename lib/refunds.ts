/**
 * What a refund takes back, decided in one place.
 *
 * A buyer who is refunded in full has been given their money back, and what
 * they bought closes for them the same way everywhere Marktmorgen hands it over:
 *
 *   - the download on the thanks page, and the emailed link to it, stop
 *     working on the next request (lib/store-checkout.ts, readOrder, which
 *     reads the payment from Stripe every time);
 *   - the list of purchases leaves it off (lib/buyer-orders.ts);
 *   - the course closes within ten minutes, the time Stripe's answer about a
 *     student is kept (lib/learn.ts);
 *   - the community closes within five, for the same reason
 *     (lib/community-access.ts);
 *   - a license key given for it is marked revoked by the five-minute job,
 *     which reads the refunds made on the creator's account
 *     (lib/licence-keys.ts, revokeRefunded), so the creator's own software
 *     hears "revoked" from the public check.
 *
 * The rule is the same for all of them: the payment was refunded in full,
 * as Stripe says on the charge, or the bank took it back for good, a dispute
 * Stripe closed as lost (queue 388 [TB14], F38; audit MM-SA-18). A buyer who
 * won a chargeback has their money back exactly as a refunded one has, so
 * the same doors close, after the same delays as above (the jobs that revoke
 * keys, end call meetings and mark reviews read the disputes closed since
 * their last run, as they read refunds). A dispute still open (needs_response,
 * under_review, the warning_ stages) or won by the creator closes nothing:
 * only the final "lost" does. A partial refund keeps access, because the
 * creator chose to keep part of the price, and the buyer keeps what it paid
 * for. A lost dispute closes whatever its amount: Stripe says a dispute's
 * amount is "usually the amount of the charge, but it can differ (usually
 * because of currency fluctuation or because only part of the order is
 * disputed)" (API reference, the Dispute object's `amount`, version
 * 2026-09-30, read 4 November 2026), and nothing on the dispute or the
 * charge tells the two apart. Reading a lost dispute for less than the
 * charge as partial would leave a buyer whose bank took the whole payment
 * back through an exchange rate with everything (inbox C4-9); no tolerance
 * is invented, so a lost dispute is read as the whole payment taken back.
 * The owner confirmed this rule on 4 November 2026 (inbox C4-13): a dispute
 * closed as lost closes the whole order, whatever its amount, because the
 * bank gave the money back to the buyer and Stripe does not say which part
 * of the order was disputed.
 *
 * On the current API Stripe does not send a charge's dispute with it, so
 * refundedInFull() alone sees refunds only. Disputes are seen only through
 * disputeLost() and what is built on it: givenBack(), keptUnlessLost(),
 * purchaseRefunded(), and the jobs' lostDisputesSince(), which the jobs that
 * take back gifts (lib/gifts.ts) and pre-orders already handed over
 * (lib/preorders.ts, revokeRefundedPreorders) read too (queue 388 [TB14],
 * 5 November 2026), and a booking's own row in lib/calls.ts, which asks
 * Stripe with keptUnlessLost() for a charge marked disputed (callOrLost, at
 * most DISPUTE_READS_PER_READING a reading). Door still judged on refunds
 * only (queue 388): the job that takes back group places (lib/group-buy.ts). A payment added in one click after checkout is its own payment and
 * is judged on its own; a product ticked at checkout is part of the
 * checkout's payment and goes with it.
 *
 * What a refund cannot take back: a file already saved, and a product
 * delivered as a link to somewhere else — once the buyer has the address,
 * only the creator can close it there.
 */
import { disputeMoneyGone } from "@/lib/retained-revenue";
import { onAccount } from "@/lib/stripe-account";
import { redisPipeline } from "@/lib/redis";

type ChargeLike = {
  id?: unknown;
  refunded?: unknown;
  amount?: unknown;
  amount_refunded?: unknown;
  disputed?: unknown;
  /**
   * Never sent by Stripe on the current API, and not expandable: written
   * here only by lostDisputesSince() from a lost dispute it read, so
   * refundedInFull() on a charge Stripe sent says nothing about disputes.
   */
  dispute?: unknown;
};

/** A dispute lost on this charge, as lostDisputesSince() writes it on the charge: the whole payment taken back, whatever its amount (above). */
function lostOnCharge(charge: ChargeLike): boolean {
  const dispute = charge.dispute as { status?: unknown } | null | undefined;
  return charge.disputed === true && !!dispute && typeof dispute === "object" && dispute.status === "lost";
}

function chargeRefunded(charge: ChargeLike): boolean {
  if (charge.refunded === true) return true;
  if (lostOnCharge(charge)) return true;
  const amount = typeof charge.amount === "number" ? charge.amount : 0;
  const back = typeof charge.amount_refunded === "number" ? charge.amount_refunded : 0;
  return amount > 0 && back >= amount;
}

/** The charge of a PaymentIntent read with its latest charge expanded, or a Charge itself. */
function chargeOf(payment: unknown): ChargeLike | null {
  if (!payment || typeof payment !== "object") return null;
  const value = payment as { object?: unknown; latest_charge?: unknown } & ChargeLike;
  if (value.object === "charge") return value;
  const charge = value.latest_charge;
  return charge && typeof charge === "object" ? (charge as ChargeLike) : null;
}

/**
 * Whether Stripe says this payment was refunded in full. On a charge Stripe
 * sent this is refunds only; a lost dispute is seen here only on a row
 * lostDisputesSince() built. Doors use givenBack() or purchaseRefunded().
 *
 * Takes a PaymentIntent read with its latest charge expanded, or a Charge
 * itself. Anything Stripe did not expand, or did not send, counts as not
 * refunded: only Stripe saying so closes a door.
 */
export function refundedInFull(payment: unknown): boolean {
  const charge = chargeOf(payment);
  return charge ? chargeRefunded(charge) : false;
}

const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]{6,255}$/;

/**
 * Every status Stripe gives a dispute and a refund (the Dispute and Refund
 * objects in Stripe's API reference). A reading that decides from one
 * accepts only these (Codex Q on #2724; CX-123 rule 24): a status missing,
 * of another type or not among them is unknown, never "not lost" or "not
 * refunded", so the job keeps its place and its anchor and reads it again.
 */
const DISPUTE_STATUSES = new Set(["warning_needs_response", "warning_under_review", "warning_closed", "needs_response", "under_review", "won", "lost", "prevented", "charge_refunded"]);
const REFUND_STATUSES = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);

/** A time Stripe sends: whole seconds. */
const secondsKnown = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * One row of GET /refunds read with `expand[]=data.charge`, in its exact
 * shape: its id and time, a status Stripe gives a refund, its payment as an
 * id or nothing, and its charge expanded with whether it was refunded, or
 * nothing. A row of any other shape is unknown (Codex Q, review 5794657228):
 * the jobs that read refunds (lib/gifts.ts, lib/preorders.ts) leave their
 * anchor where it was rather than move it past money that may have gone back.
 */
export function refundRowKnown(row: unknown): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const refund = row as Record<string, unknown>;
  if (typeof refund.id !== "string" || !refund.id || !secondsKnown(refund.created)) return false;
  if (typeof refund.status !== "string" || !REFUND_STATUSES.has(refund.status)) return false;
  if (refund.payment_intent !== null && (typeof refund.payment_intent !== "string" || !refund.payment_intent)) return false;
  if (refund.charge === null) return true;
  return !!refund.charge && typeof refund.charge === "object" && !Array.isArray(refund.charge) && typeof (refund.charge as { refunded?: unknown }).refunded === "boolean";
}

/**
 * One charge.dispute.closed event in its exact shape: its id and time, and
 * its dispute with a status Stripe gives one, its payment as an id, the
 * payment itself with its id (never empty), or nothing, and, when lost, its
 * charge's id.
 * Anything else is unknown (Codex Q, review 5794657228): never passed over
 * as a dispute not lost.
 */
function closingKnown(event: unknown): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const closed = event as Record<string, unknown>;
  if (typeof closed.id !== "string" || !closed.id || !secondsKnown(closed.created)) return false;
  const data = closed.data;
  const dispute = data && typeof data === "object" ? (data as { object?: unknown }).object : null;
  if (!dispute || typeof dispute !== "object" || Array.isArray(dispute)) return false;
  const { status, payment_intent: payment, charge } = dispute as Record<string, unknown>;
  if (typeof status !== "string" || !DISPUTE_STATUSES.has(status)) return false;
  // An id that names a payment, as text or on the expanded payment, or null: an empty id names none (Codex Q, review 5794829222).
  const paymentKnown = payment === null || (typeof payment === "string" && !!payment) || (!!payment && typeof payment === "object" && !Array.isArray(payment) && typeof (payment as { id?: unknown }).id === "string" && !!(payment as { id: string }).id);
  if (!paymentKnown) return false;
  return status !== "lost" || CHARGE_ID.test(idOf(charge));
}

/**
 * Whether the bank took this payment back from the creator for good: a
 * dispute on its charge that Stripe has closed as lost, whatever its amount
 * (the owner's rule of 4 November 2026; the header says why), or closed as
 * prevented by a resolution whose own balance transactions took the money
 * and did not put it back (disputeMoneyGone, lib/retained-revenue.ts; a
 * block, which leaves the money with the creator, is not lost, and money
 * that cannot be read is neither, so this throws). Takes what
 * refundedInFull() takes. Stripe marks a disputed charge with `disputed` but
 * no longer sends the dispute with it, and nothing can expand it, so only
 * for a charge marked disputed (rare) is Stripe asked for that charge's
 * disputes: a door reading an undisputed payment makes no extra request.
 * A charge not expanded, or not marked, counts as not lost, as with refunds.
 * Throws when Stripe cannot be asked, and when its answer is not this
 * charge's own list (rule 30): a reply that is not a list, a row that is not
 * a dispute object, a row naming another charge or none, and a list not said
 * to be whole without a lost row of its own. Not paged, so no request is
 * added: a charge with more disputes than one page holds reads as unknown.
 */
export async function disputeLost(account: string, payment: unknown): Promise<boolean> {
  const charge = chargeOf(payment);
  if (!charge || charge.disputed !== true) return false;
  if (lostOnCharge(charge)) return true;
  const id = typeof charge.id === "string" ? charge.id : "";
  if (!CHARGE_ID.test(id)) return false;
  const listed: unknown = await onAccount("GET", account, `/disputes?${new URLSearchParams({ charge: id, limit: "10" })}`);
  // Rule 30: only this charge's own rows, in a list, decide; anything else throws, as Stripe not answering does.
  if (listed === null || typeof listed !== "object" || !Array.isArray((listed as { data?: unknown }).data)) throw new Error("this charge's disputes could not be read");
  let lost = false;
  let unread = false;
  for (const row of (listed as { data: unknown[] }).data) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("a dispute listed for this charge could not be read");
    // Another charge's lost dispute, or one naming none, would close the doors on a buyer who paid.
    if (idOf((row as { charge?: unknown }).charge) !== id) throw new Error("Stripe listed another charge's dispute");
    const status = (row as { status?: unknown }).status;
    if (status === "lost") lost = true;
    else if (status === "prevented") {
      // A resolution gave the money back to the buyer, as a lost dispute does; a block left it with the creator.
      // Read by the dispute's own money (disputeMoneyGone): taken and not put back is lost, nothing taken or all
      // of it put back is not, and money that cannot be read is neither (rule 24).
      const gone = disputeMoneyGone(row);
      if (gone === true) lost = true;
      else if (gone === null) unread = true;
    }
  }
  // Its own lost dispute is lost whatever else there is; "not lost" only from a list that says, exactly, there is
  // no more, and in which every prevented dispute's money was read.
  if (lost) return true;
  if (unread) throw new Error("a prevented dispute's money on this charge could not be read");
  if ((listed as { has_more?: unknown }).has_more !== false) throw new Error("this charge's disputes were not read whole");
  return false;
}

/**
 * disputeLost() for a door that lets in: a dispute Stripe could not be asked
 * about counts as not lost, as a plan's first payment does in
 * purchaseRefunded(). The money is with the buyer either way, keeping access
 * a moment longer costs next to nothing and the next read corrects it, while
 * closing on a failed read would lock paying buyers out whenever Stripe is
 * slow.
 */
export async function keptUnlessLost(account: string, payment: unknown): Promise<boolean> {
  try {
    return await disputeLost(account, payment);
  } catch (error) {
    console.error("reading a payment's dispute failed", error);
    return false;
  }
}

/** Refunded in full, or lost to a dispute: given back either way. Throws when Stripe cannot be asked. */
export async function givenBack(account: string | null | undefined, payment: unknown): Promise<boolean> {
  if (refundedInFull(payment)) return true;
  return account ? disputeLost(account, payment) : false;
}

/**
 * A payment given back, as the jobs that take things back read them: a
 * refund from /refunds (its charge expanded), or a dispute closed as lost,
 * read by lostDisputesSince() in the same shape. `id` is what the job keeps
 * as read (re_… or the evt_… of the closing).
 */
export type GivenBackRow = Record<string, unknown>;

/**
 * Whether one row of a job's reading takes its sale back: a full refund going through, or a dispute lost, or one
 * closed as prevented by a resolution whose own money was taken and not put back (disputeMoneyGone). A prevented row
 * whose money cannot be read throws (rule 24), never "not given back": lostDisputesSince() never builds one (it stops
 * the page as not read whole instead), and a job that let it pass as not given back would move its place past it.
 */
export function rowGivesBack(row: GivenBackRow): boolean {
  if (row.object === "dispute") {
    if (row.status === "lost") return refundedInFull(row.charge);
    if (row.status !== "prevented") return false;
    const gone = disputeMoneyGone(row);
    if (gone === null) throw new Error("a prevented dispute's money could not be read");
    return gone && refundedInFull(row.charge);
  }
  if (row.status !== "succeeded" && row.status !== "pending") return false;
  return refundedInFull(row.charge);
}

/**
 * The most pages of closing events one job's run reads for one store: each
 * a GET /events of up to 100, every five minutes, by the five jobs that
 * take things back (lib/licence-keys.ts, lib/call-meetings.ts,
 * lib/review-proof.ts, lib/gifts.ts, lib/preorders.ts). No other call: the
 * dispute in the event says all a row needs.
 */
export const LOST_DISPUTE_PAGES = 3;

/**
 * The disputes on the creator's account that Stripe closed as lost since
 * (each the whole order taken back, whatever its amount: the owner's rule of
 * 4 November 2026, in the header), and those closed as prevented by a
 * resolution whose own money was taken and not put back (disputeMoneyGone)
 * `since` (seconds), read from the closing events, which Stripe keeps thirty
 * days: each as a row rowGivesBack() takes, `id` the event's, `created` the
 * time it closed, `payment_intent` the payment it took back, `charge` the
 * charge's id marked lost. `complete` is false when there were more than the
 * pages read, or the job's `deadline` (milliseconds) came first, so the
 * caller keeps its place and reads them again next time. Throws when Stripe
 * cannot be asked; the jobs use lostDisputesOrRetry().
 */
/**
 * Where a job left off in a store's closing events when there were more than
 * it may read in one run (review of #2129, inbox C4-15 (3)(c)): Stripe lists
 * them newest first, so without this a store with more lost disputes in the
 * window than LOST_DISPUTE_PAGES pages would read the same newest pages every
 * run and its job's place would never move. Kept with the `since` it was read
 * from, so a cursor of another window is never followed; 30 days, the time
 * Stripe keeps the events.
 */
export const lostCursorKey = (job: string, id: string) => `nl:lostdispute:cursor:${job}:${id}`;
const CURSOR_SECONDS = 30 * 86_400;

/**
 * What lostDisputesSince() read: its rows, whether it reached the end, the
 * newest closing of the whole sweep, whether it went on from a place kept
 * by an earlier run, and `commit`, which keeps the place for the next run.
 */
export type LostRead = { rows: GivenBackRow[]; complete: boolean; newest: number; resumed: boolean; commit: () => Promise<void> };

/**
 * Keeps a job's place in the lost disputes only when every row it read was
 * handled, that is, is in the job's set of rows already read (one SMISMEMBER):
 * a row passed over for the run's lookups, its time or an error leaves the
 * place where it was, and the next run reads it again. True when kept.
 */
export async function confirmLostRead(read: LostRead, seenKey: string): Promise<boolean> {
  const ids = read.rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
  if (ids.length) {
    const [flags] = await redisPipeline([["SMISMEMBER", seenKey, ...ids]]);
    if (!Array.isArray(flags) || flags.length !== ids.length || flags.some((flag) => Number(flag) !== 1)) return false;
  }
  await read.commit();
  return true;
}

/** The cursor of this window, and the newest closing the sweep has seen so far (0 when there is none). */
async function readCursor(key: string | undefined, since: number): Promise<{ after: string; newest: number }> {
  if (!key) return { after: "", newest: 0 };
  const [value] = await redisPipeline([["GET", key]]);
  if (typeof value !== "string") return { after: "", newest: 0 };
  const [at, id, top] = value.split("|");
  const newest = Number(top);
  return at === String(since) && /^evt_[A-Za-z0-9]{6,255}$/.test(id ?? "") && Number.isSafeInteger(newest) && newest >= 0
    ? { after: id as string, newest }
    : { after: "", newest: 0 };
}

export async function lostDisputesSince(
  account: string,
  since: number,
  deadline = Number.POSITIVE_INFINITY,
  pages = LOST_DISPUTE_PAGES,
  cursor?: string,
): Promise<LostRead> {
  const found: GivenBackRow[] = [];
  const window = Math.max(0, Math.floor(since));
  // Older pages a run before could not reach come first; the newest ones were handled then (each job keeps what it has read).
  const kept = await readCursor(cursor, window);
  let after = kept.after;
  let newest = kept.newest;
  // `newest`: the latest closing of the whole sweep, so a job that reaches the end moves its place past every page it read,
  // not only past this run's older ones (which would read the same newest pages again, run after run).
  // Nothing is written here (review of #2158, inbox C4-24): the job confirms the place with confirmLostRead() only once
  // it has handled every row read, so a row skipped for its lookups, its time or an error is read again next run.
  const leave = (complete: boolean): LostRead => {
    const place: (string | number)[] | null = !cursor ? null : complete || !after ? ["DEL", cursor] : ["SET", cursor, `${window}|${after}|${newest}`, "EX", CURSOR_SECONDS];
    return {
      rows: found,
      complete,
      newest,
      resumed: kept.after !== "",
      commit: async () => {
        if (place) await redisPipeline([place]);
      },
    };
  };
  for (let page = 0; page < Math.min(pages, LOST_DISPUTE_PAGES); page += 1) {
    if (Date.now() >= deadline) return leave(false);
    const query = new URLSearchParams({ type: "charge.dispute.closed", limit: "100", "created[gte]": String(Math.max(0, Math.floor(since))) });
    if (after) query.set("starting_after", after);
    const listed = await onAccount("GET", account, `/events?${query}`);
    // The page in its exact shape (Codex Q on #2724; CX-123 rule 24): a list, a has_more, and each event as
    // closingKnown() reads it, with every field that decides whether it was lost. Anything else is unknown, never
    // an empty page or a dispute not lost that completes the read: the read stops here as incomplete, so the place
    // stays before this page and the caller keeps its anchor.
    if (!Array.isArray(listed.data) || typeof listed.has_more !== "boolean") return leave(false);
    const page = listed.data as unknown[];
    if (!page.every(closingKnown)) return leave(false);
    const events = page as Record<string, unknown>[];
    // A prevented closing is a resolution (the money went back to the buyer, as a lost dispute's does) or a block
    // (the creator keeps it), read by the dispute's own money (disputeMoneyGone, lib/retained-revenue.ts). One whose
    // money cannot be read is unknown (rule 24): the page stops as not read whole, as an event closingKnown() does
    // not read does, so the place stays before it and nothing on it is passed over as not given back.
    const disputeOf = (event: Record<string, unknown>) => (event.data as { object: Record<string, unknown> }).object;
    if (events.some((event) => disputeOf(event).status === "prevented" && disputeMoneyGone(disputeOf(event)) === null)) return leave(false);
    for (const event of events) {
      const dispute = disputeOf(event);
      const resolution = dispute.status === "prevented" && disputeMoneyGone(dispute) === true;
      if (dispute.status !== "lost" && !resolution) continue;
      const chargeId = idOf(dispute.charge);
      const created = event.created as number;
      newest = Math.max(newest, created);
      found.push({
        object: "dispute",
        id: event.id,
        status: resolution ? "prevented" : "lost",
        ...(resolution ? { balance_transactions: dispute.balance_transactions } : {}),
        created,
        payment_intent: idOf(dispute.payment_intent) || null,
        // The charge's money taken back for good, as a lost dispute takes it: what refundedInFull() reads on it.
        charge: { object: "charge", id: chargeId, disputed: true, dispute: { status: "lost" } },
      });
    }
    const last = events[events.length - 1];
    if (listed.has_more !== true || !last || typeof last.id !== "string") return leave(true);
    after = last.id;
  }
  return leave(false);
}

/**
 * lostDisputesSince() for the jobs that also read refunds: a failed read
 * (a restricted key without Events, a rate limit, a timeout) gives no rows
 * and `complete` false, so the job still handles its refunds and keeps its
 * place to read the disputes again next run. Stripe keeps events thirty
 * days: a job down longer than that misses lost disputes (not refunds).
 */
export async function lostDisputesOrRetry(
  account: string,
  since: number,
  deadline = Number.POSITIVE_INFINITY,
  cursor?: string,
): Promise<LostRead> {
  try {
    return await lostDisputesSince(account, since, deadline, LOST_DISPUTE_PAGES, cursor);
  } catch (error) {
    console.error("reading the disputes closed as lost failed", error);
    return { rows: [], complete: false, newest: 0, resumed: false, commit: async () => {} };
  }
}

type SessionLike = {
  mode?: unknown;
  invoice?: unknown;
  payment_intent?: unknown;
  metadata?: Record<string, string> | null | unknown;
};

const INVOICE_ID = /^in_[A-Za-z0-9]{8,255}$/;
const INTENT_ID = /^pi_[A-Za-z0-9]{8,255}$/;

const idOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
      ? ((value as { id: string }).id)
      : "";

/**
 * Rule 30 (the same reading as lib/closing-refunds.ts, Claude 6's money review of #3097): a Stripe reply decides only
 * when it is the object asked for. Null-safe, so a 200 whose JSON body is null, a string or a number is not it either.
 */
const isOwnReply = (reply: unknown, id: string): boolean =>
  reply !== null && typeof reply === "object" && Object.hasOwn(reply, "id") && (reply as { id?: unknown }).id === id;

/**
 * Whether a payment plan's purchase was given back in full: a plan runs as a
 * subscription, so its checkout carries no payment of its own, and the one
 * that counts is its first invoice's. Read from Stripe; any answer it does
 * not give counts as not refunded, as everywhere else. So does an answer that
 * is not the object asked for (rule 30): another invoice's reply or one with
 * no id, another invoice's listed payment, a paid payment whose intent does
 * not read, a list of payments not said to be whole, and another payment's
 * reply or charge would judge this purchase by someone else's money or by part
 * of its own, and close the doors on a buyer who paid. Each throws, and the
 * purchase reads as not refunded until Stripe answers for it.
 */
async function planRefundedInFull(account: string, session: SessionLike): Promise<boolean> {
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  if (session.mode !== "subscription" || meta.kind !== "plan") return false;
  const invoice =
    typeof session.invoice === "string" ? session.invoice : (session.invoice as { id?: unknown } | null)?.id;
  if (typeof invoice !== "string" || !INVOICE_ID.test(invoice)) return false;
  try {
    // Whichever way this account's API version names it: on the invoice
    // itself (older versions), or as the invoice's payments (newer ones).
    const read: unknown = await onAccount("GET", account, `/invoices/${encodeURIComponent(invoice)}`);
    if (!isOwnReply(read, invoice)) throw new Error("Stripe answered for another invoice");
    const intents: string[] = [];
    const direct = idOf((read as { payment_intent?: unknown }).payment_intent);
    if (INTENT_ID.test(direct)) intents.push(direct);
    else {
      const listed: unknown = await onAccount("GET", account, `/invoice_payments?${new URLSearchParams({ invoice, limit: "10" })}`);
      if (listed === null || typeof listed !== "object" || !Array.isArray((listed as { data?: unknown }).data)) throw new Error("this invoice's payments could not be read");
      for (const row of (listed as { data: unknown[] }).data) {
        if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("a payment listed for this invoice could not be read");
        if (Object.hasOwn(row, "invoice") && idOf((row as { invoice?: unknown }).invoice) !== invoice) throw new Error("Stripe listed another invoice's payment");
        if ((row as { status?: unknown }).status !== "paid") continue;
        const payment = (row as { payment?: unknown }).payment;
        const pi = idOf(payment && typeof payment === "object" ? (payment as { payment_intent?: unknown }).payment_intent : undefined);
        // A paid payment whose intent does not read is not "paid by nothing": the others alone cannot say "all of it".
        if (!INTENT_ID.test(pi)) throw new Error("a paid payment of this invoice names no payment intent that reads");
        intents.push(pi);
      }
      // "All of it given back" only from a whole list: one that says, exactly, that there is no more.
      if ((listed as { has_more?: unknown }).has_more !== false) throw new Error("this invoice's payments were not read whole");
    }
    if (!intents.length) return false;
    const checked = await Promise.all(
      intents.map(async (intent) => {
        const pi: unknown = await onAccount("GET", account, `/payment_intents/${encodeURIComponent(intent)}?expand[]=latest_charge`);
        // Only this payment's own reply, and its own charge, say whether it was given back.
        if (!isOwnReply(pi, intent)) throw new Error("Stripe answered for another payment");
        const charge = (pi as { latest_charge?: unknown }).latest_charge;
        if (charge && typeof charge === "object" && Object.hasOwn(charge, "payment_intent") && idOf((charge as { payment_intent?: unknown }).payment_intent) !== intent) {
          throw new Error("Stripe answered with another payment's charge");
        }
        return givenBack(account, pi);
      }),
    );
    return checked.every(Boolean);
  } catch (error) {
    console.error("reading a payment plan's first payment failed", error);
    return false;
  }
}

/**
 * Whether a checkout's purchase was given back in full: its payment, or for a
 * payment plan its first invoice's, refunded in full or lost to a dispute.
 * The one rule for every door. A plan's later instalments, refunded or lost,
 * close nothing here, as before.
 */
export async function purchaseRefunded(account: string | null | undefined, session: SessionLike): Promise<boolean> {
  if (refundedInFull(session.payment_intent)) return true;
  if (!account) return false;
  // As for a plan's first payment below: what Stripe did not answer closes nothing.
  if (await keptUnlessLost(account, session.payment_intent)) return true;
  return planRefundedInFull(account, session);
}
