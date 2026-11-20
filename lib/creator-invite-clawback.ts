/**
 * An invite credit already on a plan whose payment is taken back by a dispute decided after it was sent (the owner's
 * decision of 19 November 2026 on #4514, part (b); Codex T, X6, G and N1, HIGH).
 *
 * Credit waits INVITE_HOLD_DAYS (the cards' 120-day dispute window) before it is added, and a payment whose dispute is
 * open earns nothing until the bank decides (lib/creator-invite-credit.ts). A dispute can still come later. Then:
 *
 *   - what is still unused of the credit comes off the creator's balance: never more than the credit, and never more
 *     than the credit left on the balance, so the balance never ends owing us and nothing is charged to a card;
 *   - what was already used is not charged to the creator: it is the company's funded exposure (scope legacy_credits,
 *     docs/funded-exposure-review.md), at most lateDisputeExposureCeilingCents for one payment;
 *   - the share and the invited creator's bonus earned with the same payment are both handled.
 *
 * It is found by the daily reading of plan disputes (lib/plan-disputes.ts), which calls clawBackInviteCredits for
 * every plan invoice whose dispute is lost; nothing else reads Stripe for it. Done once: the debit carries the credit's
 * id in its metadata and an idempotency key, the customer's balance history is read for it before any debit is sent
 * (so a debit that landed but whose reply was lost is found, never sent twice), and the credit's record keeps what was
 * taken back. Anything that does not read throws before anything is written: the dispute is asked about again on the
 * next run. Credit is never cash: it is never paid out, transferred or withdrawn, only used on Marktmorgen invoices.
 */
import { redisPipeline } from "@/lib/redis";
import { withCommandCeiling } from "@/lib/redis-ceiling";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { onPlatformAt } from "@/lib/billing";
import { storeForIdExactly } from "@/lib/store-exact";
import { type Credit, OWED_KEY, creditKey, parseCredit } from "@/lib/creator-invites";
import { INVITE_STRIPE_VERSION, customerFor } from "@/lib/creator-invite-credit";
import { type InviteTerms, inviteShare } from "@/lib/creator-invite-rules";

const INVOICE_PATTERN = /^in_[A-Za-z0-9]{6,64}$/;
/** The most pages of a customer's balance history read; a longer history is not known whole, so nothing is sent. */
const HISTORY_PAGES = 10;
/**
 * Automatic ceilings (the owner's decision: a new reading has a ceiling and its cost is a company fixed cost; unknown
 * fails, never zero). At most CLAWBACKS_PER_RUN lost disputes are handled in one daily run of lib/plan-disputes.ts (the
 * rest stay open and are handled the next day); each one sends at most CLAWBACK_COMMANDS Redis commands (held by
 * lib/redis-ceiling.ts: a pipeline that would pass it is refused before it is sent) and makes at most
 * CLAWBACK_STRIPE_CALLS calls to Stripe (its two credits' balance histories, balances, debits and corrections). Priced
 * with the invite-credit job's fixed cost (tests/plan-cost-registry.ts INVITE_CREDIT_JOB).
 */
export const CLAWBACKS_PER_RUN = 10;
export const CLAWBACK_COMMANDS = 24;
export const CLAWBACK_STRIPE_CALLS = 2 * (HISTORY_PAGES + 4);
const DEBIT_MARK = "nimbus_invite_clawback";
const FIX_MARK = "nimbus_invite_clawback_fix";
/** The mark lib/creator-invite-credit.ts puts on the credit it sends (putOnPlan). */
const SEND_MARK = "nimbus_invite_credit";

/**
 * The most one payment lost in a late dispute can cost the company in invite credit already used: the share it earned
 * its inviter and, for an invited creator's first payment, their bonus. The funded exposure's ceiling per occurrence.
 */
export function lateDisputeExposureCeilingCents(paidCents: number, terms: InviteTerms): number {
  return inviteShare(paidCents, terms) + terms.bonusCents;
}

const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** A customer's balance, exactly (negative is credit); `null` for a customer Stripe says is deleted (no credit left). */
async function balanceOf(customer: string, currency: string): Promise<number | null> {
  const read = await onPlatformAt(INVITE_STRIPE_VERSION, "GET", `/customers/${customer}`);
  if (!read || read.id !== customer) throw new UnknownReplyError("invite clawback: a customer read");
  if (read.deleted === true) return null;
  if (read.object !== "customer" || !whole(read.balance)) throw new UnknownReplyError("invite clawback: a customer's balance");
  // A balance in another currency is not this credit's: unknown, never taken as "nothing left".
  if (read.currency !== null && read.currency !== undefined && read.currency !== currency) throw new UnknownReplyError("invite clawback: a balance in another currency");
  return read.balance;
}

type Marks = { debit?: number; fix?: number; sent?: { id: string; amount: number } };

/** The credit's send, its debit and its correction already on a customer's balance, by their marks, read exactly. */
async function marksFor(customer: string, creditId: string): Promise<Marks> {
  const found: Marks = {};
  let after = "";
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (after) query.set("starting_after", after);
    const list = await onPlatformAt(INVITE_STRIPE_VERSION, "GET", `/customers/${customer}/balance_transactions?${query}`);
    const rows = list && list.object === "list" && typeof list.has_more === "boolean" && Array.isArray(list.data) && list.data.length <= 100
      ? (list.data as unknown[])
      : null;
    if (!rows) throw new UnknownReplyError("invite clawback: a customer's balance history");
    let last = "";
    for (const row of rows) {
      if (!row || typeof row !== "object") throw new UnknownReplyError("invite clawback: a balance history row");
      const { id, amount, metadata } = row as { id?: unknown; amount?: unknown; metadata?: unknown };
      if (typeof id !== "string" || !id) throw new UnknownReplyError("invite clawback: a balance history row");
      if (metadata !== null && (typeof metadata !== "object" || Array.isArray(metadata))) throw new UnknownReplyError("invite clawback: a balance history row");
      const marks = (metadata ?? {}) as Record<string, unknown>;
      for (const [mark, key] of [[DEBIT_MARK, "debit"], [FIX_MARK, "fix"], [SEND_MARK, "sent"]] as const) {
        if (marks[mark] === undefined) continue;
        if (typeof marks[mark] !== "string") throw new UnknownReplyError("invite clawback: a balance history row");
        if (marks[mark] !== creditId) continue;
        if (!whole(amount) || found[key] !== undefined) throw new UnknownReplyError("invite clawback: a debit read back");
        // A send is a credit: a negative amount. Anything else does not read as the credit sent.
        if (key === "sent") {
          if (amount >= 0) throw new UnknownReplyError("invite clawback: a credit read back");
          found.sent = { id, amount };
        } else found[key] = amount;
      }
      last = id;
    }
    if (list.has_more === false) return found;
    if (!last) throw new UnknownReplyError("invite clawback: a customer's balance history");
    after = last;
  }
  throw new UnknownReplyError("invite clawback: a balance history longer than read");
}

/** Sends one balance transaction and answers its amount, only on Stripe's receipt (a `cbtxn_` id). */
async function post(customer: string, cents: number, currency: string, mark: string, creditId: string, description: string): Promise<number> {
  const body = new URLSearchParams({ amount: String(cents), currency, description, [`metadata[${mark}]`]: creditId });
  const made = await onPlatformAt(INVITE_STRIPE_VERSION, "POST", `/customers/${customer}/balance_transactions`, body, `${mark}-${creditId}-${cents}`);
  if (typeof made.id !== "string" || !made.id.startsWith("cbtxn_") || made.id.length <= "cbtxn_".length) {
    throw new UnknownReplyError(`invite clawback: the receipt for ${creditId}`);
  }
  return cents;
}

/**
 * One credit already sent: what is unused comes off the balance, once. Answers what was taken back. A credit still
 * owed here may have reached Stripe all the same (a send whose receipt did not read stays owed, issue #4422): its own
 * send mark in the balance history decides (Claude 4's MEDIUM on #4514). Landed, it is taken back like one marked done
 * and written done, so the invite job leaves it; not landed, nothing is taken here, and the invite job, which reads its
 * invoice again before sending (stillOwed), writes it as earning nothing.
 */
async function clawOne(credit: Credit, nowSeconds: number): Promise<number> {
  if (credit.clawedAt !== undefined) return credit.clawed ?? 0;
  if (credit.state !== "done" && credit.state !== "owed") return 0;
  const found = await storeForIdExactly(credit.to);
  if (found === "unknown") throw new UnknownReplyError(`invite clawback: the store ${credit.id} went to`);
  if (found === "none" && credit.state === "owed") return 0;
  let taken = 0;
  let sent = credit;
  if (found !== "none") {
    const customer = await customerFor(found);
    // An owed credit on a store not paying yet was never sent: nothing to take.
    if (!customer && credit.state === "owed") return 0;
    // A credit marked done went on a customer: one that does not read now is unknown, never "nothing to take".
    if (!customer) throw new UnknownReplyError(`invite clawback: the customer ${credit.id} went to`);
    const marks = await marksFor(customer, credit.id);
    if (credit.state === "owed") {
      if (!marks.sent) return 0;
      sent = { ...credit, cents: -marks.sent.amount, state: "done", txn: marks.sent.id, doneAt: nowSeconds };
    }
    if (marks.debit === undefined) {
      const balance = await balanceOf(customer, credit.cur);
      const left = balance === null ? 0 : Math.max(0, -balance);
      const take = Math.min(sent.cents, left);
      marks.debit = take > 0
        ? await post(customer, take, credit.cur, DEBIT_MARK, credit.id, "Marktmorgen invite credit taken back: the payment it was earned on was lost in a dispute")
        : 0;
    }
    if (marks.debit > 0 && marks.fix === undefined) {
      // Credit used between the read and the debit (an invoice finalized then) leaves the balance owing: it is put
      // back to zero at once, never more than the debit itself, so nothing is ever charged to the creator.
      const after = await balanceOf(customer, credit.cur);
      if (after !== null && after > 0) marks.fix = await post(customer, -Math.min(after, marks.debit), credit.cur, FIX_MARK, credit.id, "Marktmorgen invite credit: correction, nothing is owed");
    }
    taken = marks.debit + (marks.fix ?? 0);
  }
  // Written done (a send found here included) and off the owed list, so the invite job never sends it again.
  const wrote = repliesFor(await redisPipeline([
    ["SET", creditKey(credit.id), JSON.stringify({ ...sent, clawed: taken, clawedAt: nowSeconds })],
    ["SREM", OWED_KEY, credit.id],
  ]), 2);
  if (!wrote || wrote[0] !== "OK" || (wrote[1] !== 0 && wrote[1] !== 1)) throw new UnknownReplyError(`invite clawback: ${credit.id} written down`);
  return taken;
}

/**
 * Called by the daily reading of plan disputes for a plan invoice whose dispute is lost: the share earned on it, and
 * the invited creator's bonus earned with it (the same store, at the same moment), give back what is unused. A
 * credit still owed is left to lib/creator-invite-credit.ts, which reads the invoice again before sending and sends
 * nothing on a payment taken back. Throws when anything does not read; nothing is then marked, and it is asked again.
 */
export async function clawBackInviteCredits(invoiceId: string, nowSeconds: number): Promise<number> {
  // Credit is only ever written for an invoice id of this shape (lib/creator-invite-credit.ts): another has none.
  if (!INVOICE_PATTERN.test(invoiceId)) return 0;
  return withCommandCeiling(CLAWBACK_COMMANDS, () => clawBackWithin(invoiceId, nowSeconds));
}

async function clawBackWithin(invoiceId: string, nowSeconds: number): Promise<number> {
  const read = repliesFor(await redisPipeline([["GET", creditKey(invoiceId)]]), 1);
  if (!read) throw new UnknownReplyError("invite clawback: the share of an invoice");
  if (read[0] === null) return 0;
  const share = parseCredit(read[0]);
  if (!share || share.kind !== "share" || share.id !== invoiceId) throw new UnknownReplyError("invite clawback: the share of an invoice");
  const credits = [share];
  const bonusRead = repliesFor(await redisPipeline([["GET", creditKey(`bonus_${share.from}`)]]), 1);
  if (!bonusRead) throw new UnknownReplyError("invite clawback: the bonus earned with a share");
  if (bonusRead[0] !== null) {
    const bonus = parseCredit(bonusRead[0]);
    if (!bonus) throw new UnknownReplyError("invite clawback: the bonus earned with a share");
    if (bonus.kind === "bonus" && bonus.from === share.from && bonus.at === share.at) credits.push(bonus);
  }
  let taken = 0;
  for (const credit of credits) taken += await clawOne(credit, nowSeconds);
  return taken;
}
