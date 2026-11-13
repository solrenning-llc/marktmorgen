/**
 * The buyers of a store that closes, told by Marktmorgen itself (queue item
 * 307 [EC1], part 5; lib/closing-buyers-rules.ts says why and what).
 *
 *   tellBuyers     BUYER_NOTICE_DAYS days before the closing at the least:
 *                  one service email to everyone who bought from the store
 *                  (its members held, the payments that name it in their
 *                  metadata on the creator's Stripe account, its PayPal
 *                  sales, and the buyers it brought over or was given as
 *                  gifts), each address once, a part a day, up to a cap on
 *                  what is read
 *   tellStaysOpen  the plan was started again after that: one short email to
 *                  each address that was told
 *   tellRefundShort  a member whose refund the store's balance did not cover
 *
 * The cap, before every email: the closing's emails, set when its members
 * were held (lib/closing-credit.ts, buyerNoticeCap), a post-cancellation
 * funded exposure of docs/funded-exposure-review.md. Telling a buyer takes EMAILS_PER_BUYER_PER_ENDING from it at
 * once, the notice and the one follow-up either of the two others can be,
 * so a follow-up is never short of what it costs. An address the cap no
 * longer covers is not written to, and is counted (`untold`) for the
 * creator's notices and studio, never left silent.
 *
 *   nl:closing:credit:<folder>  what is left of the closing's emails (lib/closing-credit.ts)
 *   nl:closing:told:<folder>    the addresses told for this ending, until the store closes or stays
 *
 * Sent from Marktmorgen's own address with its postal address
 * (lib/company-postal.ts), counted on the company's sender (EmailMeter
 * "company"), never on the store's own emails, which end with its plan.
 */
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, sendBatch, type BatchMessage } from "@/lib/email";
import { onAccount } from "@/lib/stripe-account";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { textCountOf } from "@/lib/redis-count";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { type Store, saleHandles, storeFolder, storeRef } from "@/lib/store";
import { readPayPalSales } from "@/lib/paypal-sales";
import { importedBuyers } from "@/lib/imported-purchases";
import { storeBase } from "@/lib/purchase-email";
import { formatMoney } from "@/lib/money";
import { companyPostal } from "@/lib/company-postal";
import { membersOf, paidPeriods } from "@/lib/closing-holds";
import { returnCredit, takeCredit } from "@/lib/closing-credit";
import {
  BUYER_PAGES_PER_RUN,
  EMAILS_PER_BUYER_PER_ENDING,
  type BuyerLetter,
  buyerNotice,
  letterHtml,
  refundShortLetter, refundUnmadeLetter,
  staysOpenLetter,
  unusedOf,
} from "@/lib/closing-buyers-rules";

export const toldKey = (folder: string) => `nl:closing:told:${folder}`;

/**
 * How a buyer reaches the creator, as the creator published it: the contact
 * form on the store's page when it is on, and otherwise a reply to this
 * email, which goes to them (reply-to). The creator's own sign-in address is
 * never printed.
 */
const contactOf = (store: Store) => (store.contact?.on ? `use the contact form on its page, ${storeBase(store)}#contact, or reply to this email` : "reply to this email: your reply goes to the store");
/**
 * The told list's mark for an address the cap did not cover: written once (HSETNX), so each is counted once. Each
 * write is its own mark, "x:" and 16 hex digits (untoldMark), so after a lost reply a read-back proves whether the
 * write that landed is ours (markUntold). The bare "x" of the marks written before stays read as the same mark.
 */
const UNTOLD_MARK = /^x(?::[0-9a-f]{16})?$/;
const untoldMark = () => `x:${randomBytes(8).toString("hex")}`;
const isUntold = (raw: unknown): boolean => typeof raw === "string" && UNTOLD_MARK.test(raw);

/**
 * Marks `field` as not told and says whether this call wrote it, so it is counted once (CX-123 rule 24). HSETNX
 * answers 1 (written) or 0 (there already). Any other reply is not "not written": the field is read back once (HGET),
 * and only our own mark counts. Nil there is not written (tried again next run); another mark or a told time is not
 * ours. A read-back out of shape, text the list never holds included (markOf), throws UnknownReplyError, so the
 * closing job holds and tries again. Any throw here (that one, or a round trip that fails on the HSETNX or the
 * read-back: Codex C2 on #3009) gives back, once, the `certain` credit taken before it this round, whose emails will
 * not go now; the unknown mark itself is never given back.
 */
async function markUntold(folder: string, field: string, certain: number): Promise<boolean> {
  try {
    return await markUntoldOnce(folder, field);
  } catch (error) {
    await returnCredit(folder, certain).catch((failed) => console.error("giving back a closing's email credit failed; not tried again", failed));
    throw error;
  }
}

async function markUntoldOnce(folder: string, field: string): Promise<boolean> {
  const mark = untoldMark();
  const written = repliesFor(await redisPipeline([["HSETNX", toldKey(folder), field, mark]]), 1)?.[0];
  if (written === 1 || written === 0) return written === 1;
  const back = repliesFor(await redisPipeline([["HGET", toldKey(folder), field]]), 1)?.[0];
  if (back === mark) return true;
  // Nil, or what the list holds (a mark, or a told time) that is not ours: not written by this call.
  if (back === null || (typeof back === "string" && markOf(back) !== null)) return false;
  throw new UnknownReplyError("whether a closing's buyer was marked as not told");
}

/**
 * One entry of the told list, only in its exact shape (audit SG2, CX-123
 * rule 24): "absent" when the address is not on it (HGET and HMGET answer
 * null), "untold" for the cap's mark, when it was told (the ending's time,
 * as written), or null: unknown, and then nothing is sent on it this round.
 */
function markOf(raw: unknown): "absent" | "untold" | number | null {
  return isUntold(raw) ? "untold" : textCountOf(raw);
}

/**
 * takeCredit, and when its reply is unknown (it throws), gives back the
 * `certain` credit taken before it in the same round, whose emails will not
 * go now, and throws again (review 1 of SG2 L8). The unknown take itself is
 * never given back: it is not known whether it ran.
 */
async function takeCreditOrGiveBack(folder: string, n: number, certain: number): Promise<boolean> {
  try {
    return await takeCredit(folder, n);
  } catch (error) {
    await returnCredit(folder, certain).catch((failed) => console.error("giving back a closing's email credit failed; not tried again", failed));
    throw error;
  }
}

function message(store: Store, to: string, letter: BuyerLetter, postal: string): BatchMessage {
  const text = `${letter.text}\n\nMarktmorgen, ${postal}`;
  return { from: NIMBUS_FROM, to, replyTo: store.email, subject: letter.subject, text, html: letterHtml(letter.text, postal, letter.subject), tags: { kind: "closing_notice" } };
}

/** Sends one batch; true when it went. */
async function send(messages: BatchMessage[], key: string): Promise<boolean> {
  if (!messages.length) return true;
  const sent = await sendBatch(messages, key, { by: "company" });
  if (sent !== "sent") console.error(`a closing store's buyers' emails were not sent (${sent}); tried again tomorrow`);
  return sent === "sent";
}

const batchKey = (what: string, folder: string, endedAt: number, to: string[]) =>
  `closing:${what}:${createHash("sha256").update(`${folder}:${endedAt}:${to.join(",")}`).digest("hex").slice(0, 40)}`;

/** The address of a payment found by the store's own metadata: the receipt's, or the card's. */
function payerOf(row: Record<string, unknown>): string {
  if (typeof row.receipt_email === "string" && row.receipt_email) return row.receipt_email;
  const charge = row.latest_charge && typeof row.latest_charge === "object" ? (row.latest_charge as { billing_details?: { email?: unknown } | null; receipt_email?: unknown }) : null;
  if (typeof charge?.receipt_email === "string" && charge.receipt_email) return charge.receipt_email;
  return typeof charge?.billing_details?.email === "string" ? charge.billing_details.email : "";
}

export type Told = { done: boolean; after: string; pages: number; sent: number; untold: number; capped?: boolean; blocked?: "postal" };

/** The most pages of a hundred payments read for one closing: two for every hundred buyers its cap allows, and a few more. Past it the rest is counted as not read, never waited on. */
export function buyerPagesCap(cap: number): number {
  return Math.ceil((2 * cap) / 100) + 5;
}

const CURSOR = /^(start|\d{1,3}\|[!-~]{0,800})$/;

/**
 * One page of Stripe's payment search, only in its exact shape (rule 30, the
 * same class as eachSold in lib/closing-holds.ts, Claude 6 on #3108): its
 * rows, each an object, and the cursor to the next page, or "" on a page
 * Stripe says is the last (has_more false). Null for anything else: has_more
 * missing or not a boolean, has_more true with no cursor that is text, or
 * data that is not a list. Such a page is never read as the last one, which
 * would end the round with the rest of the handle's buyers never told.
 */
function searchPageOf(reply: unknown): { rows: Record<string, unknown>[]; next: string } | null {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return null;
  const { data, has_more: more, next_page: next } = reply as { data?: unknown; has_more?: unknown; next_page?: unknown };
  if (!Array.isArray(data) || !data.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) return null;
  if (more === false) return { rows: data as Record<string, unknown>[], next: "" };
  if (more === true && typeof next === "string" && next) return { rows: data as Record<string, unknown>[], next };
  return null;
}

/**
 * Tells the next part of the store's buyers. `after` is where the last run
 * stopped ("" the first time: then the buyers kept here, the members held
 * and those brought over or paid with PayPal, are told first; each address
 * told is written down at once, so a run that stops part-way never writes to
 * anybody twice). Then the payments that name this store in their own
 * metadata, found by Stripe's search on the creator's account (never the
 * account's whole history), BUYER_PAGES_PER_RUN pages a run and `maxPages`
 * in all; at that cap it is done, and says it was `capped`. `day` is the
 * closing day the emails name.
 */
export async function tellBuyers(store: Store, endedAt: number, day: number, after: string, until: number, pagesRead = 0, maxPages = Number.POSITIVE_INFINITY): Promise<Told> {
  const postal = companyPostal();
  if (!postal) return { done: false, after, pages: pagesRead, sent: 0, untold: 0, blocked: "postal" };
  const folder = await storeFolder(storeRef(store));
  const out: Told = { done: false, after: CURSOR.test(after) ? after : "", pages: pagesRead, sent: 0, untold: 0 };
  const members = new Map<string, string>();
  for (const paid of (await paidPeriods(store)).values()) {
    const unused = unusedOf(paid, day);
    if (paid.e) members.set(paid.e, unused > 0 ? formatMoney(unused, paid.cur) : members.get(paid.e) ?? "");
  }
  const held = await membersOf(folder);
  for (const email of held.emails) if (!members.has(email)) members.set(email, "");
  // Members whose payments were not paused (any of their memberships): never told they stopped.
  const unpaused = new Set(held.unpaused);
  const base = storeBase(store);
  const tell = async (raw: string[]): Promise<boolean> => {
    const fresh = [...new Set(raw.map((e) => normaliseEmail(e)).filter((e) => EMAIL_PATTERN.test(e)))];
    if (!fresh.length) return true;
    const known = repliesFor(await redisPipeline([["HMGET", toldKey(folder), ...fresh]]), 1)?.[0];
    // A told list that cannot be read is never "nobody told yet": nobody is written to this round.
    const marks = Array.isArray(known) && known.length === fresh.length ? known.map(markOf) : null;
    if (marks === null || marks.includes(null)) return false;
    const todo = fresh.filter((_, i) => marks[i] === "absent");
    for (let i = 0; i < todo.length; i += 100) {
      const going: string[] = [];
      for (const email of todo.slice(i, i + 100)) {
        if (await takeCreditOrGiveBack(folder, EMAILS_PER_BUYER_PER_ENDING, going.length * EMAILS_PER_BUYER_PER_ENDING)) going.push(email);
        // Counted once however many times the address turns up (HSETNX of our own mark).
        else if (await markUntold(folder, email, going.length * EMAILS_PER_BUYER_PER_ENDING)) out.untold += 1;
      }
      const letters = going.map((email) =>
        message(store, email, buyerNotice({ store: store.name, storeUrl: base, day, contact: contactOf(store), member: members.has(email), paused: !unpaused.has(email), refund: members.get(email) || undefined }), postal),
      );
      if (!(await send(letters, batchKey("notice", folder, endedAt, going)))) {
        await returnCredit(folder, going.length * EMAILS_PER_BUYER_PER_ENDING);
        return false;
      }
      if (going.length) await redisPipeline([["HSET", toldKey(folder), ...going.flatMap((email) => [email, String(endedAt)])]]);
      out.sent += going.length;
    }
    return true;
  };

  if (!out.after) {
    // (The told list of an earlier ending was let go when this one's members were held: lib/plan-closing.ts.)
    // A member with no address on Stripe cannot be told: counted, once.
    for (const sub of held.missing) if (await markUntold(folder, `#${sub}`, 0)) out.untold += 1;
    const kept: string[] = [...members.keys()];
    kept.push(...(await importedBuyers(store.statsId)).keys());
    kept.push(...(await readPayPalSales(store.statsId, 0, 100_000)).sales.map((sale) => sale.email));
    if (!(await tell(kept))) return out;
    out.after = "start";
  }
  const account = store.stripeAccountId;
  if (!account) return { ...out, done: true };
  const handles = [...saleHandles(store)];
  let [h, page] = out.after === "start" ? [0, ""] : [Number(out.after.split("|")[0]), out.after.slice(out.after.indexOf("|") + 1)];
  for (let run = 0; run < BUYER_PAGES_PER_RUN; run += 1) {
    if (h >= handles.length) return { ...out, done: true };
    if (out.pages >= maxPages) return { ...out, done: true, capped: true };
    if (Date.now() > until) return out;
    const query = new URLSearchParams({ limit: "100", query: `metadata['store']:'${handles[h]}' AND status:'succeeded'` });
    query.append("expand[]", "data.latest_charge");
    if (page) query.set("page", page);
    const list = await onAccount("GET", account, `/payment_intents/search?${query}`);
    out.pages += 1;
    // A page out of shape acts on none of its rows and the round is not done: the cursor stays where it was and the
    // closing job asks for the same page again; only a page Stripe says is the last finishes the handle (rule 30).
    const found = searchPageOf(list);
    if (!found) {
      console.error("closing-buyers: Stripe's payment search gave a page that does not say exactly whether more follow; tried again");
      return out;
    }
    if (!(await tell(found.rows.map(payerOf)))) return out;
    [h, page] = found.next ? [h, found.next] : [h + 1, ""];
    out.after = `${h}|${page}`;
  }
  return h >= handles.length ? { ...out, done: true } : out;
}

/** The short email to everyone told, once the plan runs again; true when all of it went (or there was nobody). */
export async function tellStaysOpen(store: Store, until: number): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const folder = await storeFolder(storeRef(store));
  const postal = companyPostal();
  const base = storeBase(store);
  for (let round = 0; round < 1_000; round += 1) {
    if (Date.now() > until) return false;
    // Only a page in its exact shape, [cursor, field, value, ...]; anything else holds and is tried again (rule 24).
    const page = repliesFor(repliesFor(await redisPipeline([["HSCAN", toldKey(folder), "0", "COUNT", 100]]), 1)?.[0], 2);
    const flat = page && typeof page[0] === "string" ? stringList(page[1]) : null;
    if (!flat || flat.length % 2 !== 0) return false;
    const told: { email: string; ending: string }[] = [];
    const untold: string[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      if (isUntold(flat[i + 1])) untold.push(flat[i]);
      else told.push({ email: flat[i], ending: flat[i + 1] });
    }
    if (untold.length) await redisPipeline([["HDEL", toldKey(folder), ...untold]]);
    if (!told.length && !untold.length) return true;
    if (!told.length) continue;
    // Each was told with a follow-up paid for (tellBuyers takes both at once); without an address of ours to sign with, nothing goes.
    if (!postal) return false;
    const letters = told.map(({ email }) => message(store, email, staysOpenLetter({ store: store.name, storeUrl: base, contact: contactOf(store) }), postal));
    if (!(await send(letters, batchKey("stays", folder, Number(told[0].ending) || 0, told.map((t) => t.email))))) return false;
    await redisPipeline([["HDEL", toldKey(folder), ...told.map((t) => t.email)]]);
  }
  return false;
}

/**
 * While the store is closing: whether the person's address is on the list of
 * buyers to tell, and when they were told (0 while not yet), for the copy of
 * their data (619 [SZ3]); null when it is not on it. Only reads.
 */
export async function toldOf(store: Store, email: string): Promise<{ toldAt: number } | null> {
  if (!isRedisConfigured()) return null;
  const folder = await storeFolder(storeRef(store));
  const mark = markOf(repliesFor(await redisPipeline([["HGET", toldKey(folder), normaliseEmail(email)]]), 1)?.[0]);
  // Unknown is never "not yet": it fails the whole copy (lib/person-copy.ts, copyPerson), as any read that fails does.
  if (mark === null) throw new UnknownReplyError("an entry of a closing's told list");
  if (mark === "absent") return null;
  return { toldAt: mark === "untold" ? 0 : mark };
}

/**
 * The email to members whose refund could not be made on the closing day.
 * Paid for by the follow-up taken when they were told; one who was not told
 * takes it from the store's credit now. True when every one went or was
 * counted as not coverable.
 */
export async function tellRefundShort(store: Store, short: { email: string; amount: number; cur: string }[], endedAt: number, why: "balance" | "limit" = "balance"): Promise<{ sent: number; untold: number; ok: boolean }> {
  const postal = companyPostal();
  const out = { sent: 0, untold: 0, ok: true };
  if (!short.length) return out;
  if (!postal) return { ...out, ok: false };
  const folder = await storeFolder(storeRef(store));
  // Every member's mark is read before any credit is taken: one that cannot
  // be read (audit SG2, CX-123 rule 24) is not known to be paid for or not,
  // so nothing is taken or sent this round, and it is tried again.
  const rows: { row: (typeof short)[number]; email: string; told: boolean }[] = [];
  for (const row of short) {
    const email = normaliseEmail(row.email);
    if (!EMAIL_PATTERN.test(email)) {
      out.untold += 1;
      continue;
    }
    const mark = markOf(repliesFor(await redisPipeline([["HGET", toldKey(folder), email]]), 1)?.[0]);
    if (mark === null) return { ...out, ok: false };
    rows.push({ row, email, told: typeof mark === "number" });
  }
  const going: BatchMessage[] = [];
  const addresses: string[] = [];
  let taken = 0;
  for (const { row, email, told } of rows) {
    if (!told) {
      if (!(await takeCreditOrGiveBack(folder, 1, taken))) {
        out.untold += 1;
        continue;
      }
      taken += 1;
    }
    addresses.push(email);
    const letter = why === "limit" ? refundUnmadeLetter : refundShortLetter;
    going.push(message(store, email, letter({ store: store.name, amount: formatMoney(row.amount, row.cur), contact: contactOf(store) }), postal));
  }
  for (let i = 0; i < going.length; i += 100) {
    if (!(await send(going.slice(i, i + 100), batchKey(why === "limit" ? "unmade" : "short", folder, endedAt, addresses.slice(i, i + 100))))) return { ...out, ok: false };
    out.sent += Math.min(100, going.length - i);
  }
  return out;
}

/** Once the store is closed or runs on: the addresses told are let go. */
export async function forgetTold(folder: string): Promise<void> {
  await redisPipeline([["DEL", toldKey(folder)]]);
}
