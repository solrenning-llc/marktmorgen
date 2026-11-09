/**
 * An order's email that a sender refused for certain is owed, never dropped
 * (the owner's EM1, 1 November 2026: with Amazon SES paused, busy or saying
 * no and the Resend fallback blocked, the email "waits, never discarded";
 * Claude 5's email audit of 9 November 2026, HIGH 2).
 *
 * sendEmail answers false both when a sender refused the email for certain
 * and when its answer is not known, and the order emails that called it
 * (a call package's booking link, a booked call's two confirmations, a
 * license key for a buyer who waited, a gift and its receipt) threw that
 * answer away: the record was written once, so nothing ever asked again.
 * sendOrderMail tells the three apart (sendEmailOutcome):
 *
 *   sent       done;
 *   uncertain  it may have gone: never sent again, only logged;
 *   refused    owed: kept here and tried again by the email job
 *              (app/api/cron/mail) after OWED_MAIL_RETRY_SECONDS (a quarter
 *              of an hour, past a paused sender's ten minutes; then a day,
 *              past a spent daily quota), until it is sent, its answer is not
 *              known, or it was refused REFUSED_TRIES times in all
 *              (lib/refused-tries.ts, the count every caller that asks again
 *              shares); then the creator is told once, so the buyer still
 *              hears from them. That notice is owed the same way (pre-review
 *              of a423c617da, A1): refused, it is tried again on the same
 *              schedule, and given up only with a log, never a second notice.
 *
 * Every try keeps the email's own idempotency key. A try is made again only
 * after a certain refusal (no sender took it), so one made past a sender's
 * one-day idempotency window is never a second copy: nothing was taken.
 *
 * A person erased from the store (lib/suppression.ts, nl:erased:<listId>) is
 * never sent an owed email, and the creator is never told their address
 * (pre-review M1): the email is dropped with a log, as every other sending
 * path drops a deleted address. A read of it that does not answer 0 or 1
 * (rule 24) leaves the email for the next try, sending nothing.
 *
 * A creator's own notice about an order (sendStoreNotice: a buyer waits for
 * a license key, the pool of keys runs low, lib/licence-keys.ts; rule 30 of
 * EM1) is owed the same way, with three differences. Every try is taken from
 * the store's own email figure (meter "store"), as the notice always was, so
 * a notice that is sent takes it once and N certain refusals take it at most
 * REFUSED_TRIES times. It carries what must still be true for it to be sent
 * (`still`: the buyer still waits, the pool's warning is still the one
 * claimed), read before each try again, so a notice no longer true is let go
 * unsent and takes nothing. And given up it is logged only: the creator is
 * the one it could not reach. It goes to the creator's own address, which is
 * not a subscriber of the store, so the erased prints (M1) are not read for
 * it; the buyer a waiting notice names is covered by `still` (the waiting
 * record), which is gone once the buyer is served or the sale forgotten.
 *
 * Keys (one family, nl:owedmail:):
 *
 *   nl:owedmail:due        sorted set for every store: "<id>|<store>", scored
 *                          by when it is tried next (never an address)
 *   nl:owedmail:m:<id>     the email as written, with its store's handle,
 *                          OWED_MAIL_KEEP_SECONDS at most
 *   nl:owedmail:s:<store>  the ids a store owes, OWED_MAIL_PER_STORE at most
 *   nl:owedmail:told:<id>  the creator was told this one was given up
 *
 * <id> is a hash of the email's idempotency key; <store> its store's id, so
 * an email whose record ran out is still taken off its store's count (L2).
 * A store owing OWED_MAIL_PER_STORE already, an email over
 * OWED_MAIL_MAX_BYTES, or a write that does not answer as it should is given
 * up at once, and the creator is told why: never kept past the bound, never
 * silently lost.
 */
import { createHash } from "node:crypto";
import { NIMBUS_FROM, type SendOutcome, sendEmailOutcome } from "@/lib/email";
import type { AllowanceStore } from "@/lib/store-allowance";
import { REFUSED_TRIES, countRefusal } from "@/lib/refused-tries";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, stringList } from "@/lib/redis-reply";

/** The message sendEmailOutcome takes; an order email is always counted against its order (meter "order"). */
export type OrderMessage = Omit<Parameters<typeof sendEmailOutcome>[0], "meter" | "idempotencyKey" | "html" | "headers"> & {
  /** Its own, for the email: the same on every try, so a sender never sends it twice. */
  idempotencyKey: string;
};
/** The store an order email is for: who is told when it is given up, where the cap is counted, and whom it erased. */
export type OwedStore = { statsId?: string | null; handle: string; email: string; name: string; listId?: string | null };
/** A store as the email job reads it back: its plan's fields too, when a creator's notice is taken from its figure. */
export type OwedStoreRead = OwedStore & Partial<AllowanceStore>;
/** What must still be true for a creator's notice to be sent: a hash's field still there, or a key still holding the value claimed. */
export type Still = { key: string; field: string } | { key: string; value: string };
/** A creator's own notice about an order (sendStoreNotice): an order email's shape, with what must still be true. */
export type StoreNotice = OrderMessage & { still: Still };

/** Emails a store may owe at once (its notices about given-up ones included); one more is given up, and its creator told. */
export const OWED_MAIL_PER_STORE = 20;
/** The most one owed email may weigh as kept (its text and a calendar file); one heavier is given up, and its creator told. */
export const OWED_MAIL_MAX_BYTES = 16 * 1024;
/**
 * When it is tried again, after its first refusal and after its second
 * (REFUSED_TRIES in all): a quarter of an hour, past a paused sender's ten
 * minutes; then a day, past a sender's spent daily quota.
 */
export const OWED_MAIL_RETRY_SECONDS: readonly number[] = [15 * 60, 24 * 3600];
/**
 * How long an owed email is kept: an email's tries and then its notice's
 * (each a quarter of an hour and a day), with room for a late run.
 */
export const OWED_MAIL_KEEP_SECONDS = 3 * 86_400;
/** Owed emails one run of the email job tries at most. */
export const OWED_MAIL_PER_RUN = 25;
/** Commands one try again may take of its own: its share of the due read, the lease ZADD, GET, the erased read, the refusal's INCR and EXPIRE. */
const TRY_COMMANDS = 6;
/** Commands one email's first refusal takes inside its order: INCR, EXPIRE; SADD, SCARD, EXPIRE, SET, ZADD. */
const FIRST_COMMANDS = 7;
/** An owed email's end: DEL, ZREM, SREM. */
const END_COMMANDS = 3;
/**
 * Commands one owed email may take in all, besides its sends (each an order
 * email, lib/email.ts): its first refusal and its keeping, its tries again
 * and its end; given up, the erased read and the told mark, and its notice
 * the same way (refused, kept and tried again). Measured in
 * tests/order-mail-owed.test.ts.
 */
export const OWED_MAIL_COMMANDS =
  2 * (FIRST_COMMANDS + (REFUSED_TRIES - 1) * TRY_COMMANDS + END_COMMANDS) + 2;

const DUE = "nl:owedmail:due";
const idOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
const mailKey = (id: string) => `nl:owedmail:m:${id}`;
const storeKey = (store: string) => `nl:owedmail:s:${store}`;
const toldKey = (id: string) => `nl:owedmail:told:${id}`;
const memberOf = (id: string, owner: string) => `${id}|${owner}`;
const MEMBER = /^([0-9a-f]{32})\|([A-Za-z0-9_-]{1,80})$/;
const now = () => Math.floor(Date.now() / 1000);

/**
 * lib/suppression.ts suppressedCommand, here so this module reads the
 * store's erased prints without importing the sign-in code
 * (tests/order-mail-owed-callers.test.ts holds the two alike).
 */
export function erasedCommand(listId: string | null | undefined, email: string): (string | number)[] {
  if (!listId) return ["EXISTS", "nl:none"];
  const print = createHash("sha256").update(`nimbus-erased:${listId}:${email.trim().toLowerCase()}`).digest("hex").slice(0, 32);
  return ["HEXISTS", `nl:erased:${listId}`, print];
}

/** Whether the address was erased from the store: true, false, or null when the read does not answer 0 or 1 (rule 24). */
async function erased(listId: string | null | undefined, email: string): Promise<boolean | null> {
  if (!listId) return false;
  try {
    const [reply] = await redisPipeline([erasedCommand(listId, email)]);
    return reply === 1 ? true : reply === 0 ? false : null;
  } catch {
    return null;
  }
}

/**
 * "n": a notice to the creator (about an email given up, or a license-key
 * notice), given up itself only with a log. "k" and "w": a license-key notice,
 * taken from its store's figure while `w` still holds.
 */
type Owed = { h: string; s: string; m: OrderMessage; t: number; n?: 1; k?: "store"; w?: Still };

const asMessage = (message: OrderMessage) => ({ meter: { by: "order" } as const, ...message });
const asNotice = (store: AllowanceStore, message: OrderMessage) => ({ meter: { by: "store", store, kind: "email" } as const, ...message });
/** The name its refusals are counted under (lib/refused-tries.ts): the email's own key. */
const refusalName = (message: OrderMessage) => `owedmail:${message.idempotencyKey}`;
const storeOf = (store: OwedStore) => store.statsId || store.handle;

/** Why an email was given up, as its creator is told (VR 2: the real reason). */
type Reason = "tried" | "full" | "heavy" | "unsaved";
const SAID: Record<Reason, string> = {
  tried: `We tried ${REFUSED_TRIES} times over a day and then stopped, so it is never sent twice.`,
  full: "Too many emails of your store were already waiting to be tried again, so this one was not kept to try later.",
  heavy: "It was too large to keep to try later.",
  unsaved: "It could not be saved to try later.",
};

/**
 * Sends one order email, and keeps it owed when a sender refused it for
 * certain (above). Never throws for the email's sake: the order is written
 * already, and its caller goes on.
 */
export async function sendOrderMail(store: OwedStore, message: OrderMessage, what: string): Promise<SendOutcome> {
  return firstTry(store, message, what, false, null);
}

/**
 * Sends a creator's own notice about an order (above), from the store's own
 * email figure, and keeps it owed, with what must still be true for it, when
 * a sender refused it for certain. Never throws for the notice's sake.
 */
export async function sendStoreNotice(store: OwedStore & AllowanceStore, notice: StoreNotice, what: string): Promise<SendOutcome> {
  const { still, ...message } = notice;
  return firstTry(store, message, what, true, { store, still });
}

type Held = { store: AllowanceStore; still: Still };

async function firstTry(store: OwedStore, message: OrderMessage, what: string, notice: boolean, held: Held | null): Promise<SendOutcome> {
  let outcome: SendOutcome;
  try {
    outcome = await sendEmailOutcome(held ? asNotice(held.store, message) : asMessage(message));
  } catch (error) {
    // Thrown after it may have been handed over: never sent again.
    console.error(`${what}: the send threw; it may have gone, so it is not sent again`, error);
    return "uncertain";
  }
  if (outcome === "uncertain") console.error(`${what}: the sender's answer is not known; it may have gone, so it is not sent again`);
  if (outcome !== "refused") return outcome;
  // The first of its REFUSED_TRIES (lib/refused-tries.ts): a count that does not read is the limit.
  if (!(await countRefusal(refusalName(message), OWED_MAIL_KEEP_SECONDS))) {
    await giveUp(store, message, what, "unsaved", notice);
    return outcome;
  }
  const kept = await owe(store, message, OWED_MAIL_RETRY_SECONDS[0], notice, held?.still ?? null);
  if (kept !== "kept") await giveUp(store, message, what, kept, notice);
  else console.error(`${what}: refused for certain; kept to be tried again`);
  return outcome;
}

/** Writes the email down as owed, tried again `after` seconds from now. */
async function owe(store: OwedStore, message: OrderMessage, after: number, notice: boolean, still: Still | null): Promise<"kept" | Reason> {
  if (!isRedisConfigured()) return "unsaved";
  const owner = storeOf(store);
  if (!owner || !/^[A-Za-z0-9_-]{1,80}$/.test(owner)) return "unsaved";
  const id = idOf(message.idempotencyKey);
  const entry: Owed = { h: store.handle, s: owner, m: message, t: now(), ...(notice ? { n: 1 as const } : {}), ...(still ? { k: "store" as const, w: still } : {}) };
  const json = JSON.stringify(entry);
  if (Buffer.byteLength(json) > OWED_MAIL_MAX_BYTES) return "heavy";
  try {
    // The store's place first, read back: past the cap the place is given back and nothing else is written.
    const placed = repliesFor(await redisPipeline([["SADD", storeKey(owner), id], ["SCARD", storeKey(owner)], ["EXPIRE", storeKey(owner), OWED_MAIL_KEEP_SECONDS]]), 3);
    const added = placed ? countOf(placed[0]) : null;
    const count = placed ? countOf(placed[1]) : null;
    if (added === null || count === null) return "unsaved";
    if (count > OWED_MAIL_PER_STORE) {
      if (added === 1) await redisPipeline([["SREM", storeKey(owner), id]]).catch(() => {});
      return "full";
    }
    const written = repliesFor(await redisPipeline([["SET", mailKey(id), json, "EX", OWED_MAIL_KEEP_SECONDS], ["ZADD", DUE, now() + after, memberOf(id, owner)]]), 2);
    if (!written || written[0] !== "OK" || countOf(written[1]) === null) return "unsaved";
    return "kept";
  } catch (error) {
    console.error("keeping an owed order email failed", error);
    return "unsaved";
  }
}

/** Takes an owed email off every list: sent, its answer not known, erased, given up, or its record gone. */
async function finish(id: string, owner: string): Promise<void> {
  await redisPipeline([["DEL", mailKey(id)], ["ZREM", DUE, memberOf(id, owner)], ["SREM", storeKey(owner), id]]).catch((error) =>
    console.error("taking an owed order email off its list failed", error),
  );
}

/**
 * Gives an order email up: logged, and its creator told once, so the buyer
 * hears from them. Not when the email was the creator's own (telling the
 * address that refused it would be refused too), not about an erased person
 * (their address is not carried to anyone), and not about a notice itself
 * (a license-key notice to the creator included: it was to them).
 * The notice is an owed email of its own (A1): refused, it is kept and tried
 * again, so a sender refusing for a while does not lose both.
 */
async function giveUp(store: OwedStore, message: OrderMessage, what: string, why: Reason, notice: boolean): Promise<void> {
  if (notice) {
    console.error(`${what}: the creator's notice about an order email could not be sent (${why}); given up`);
    return;
  }
  console.error(`${what}: an order email to the buyer or host could not be sent (${why}); its creator is told`);
  const to = store.email.trim();
  if (!to || to.toLowerCase() === message.to.trim().toLowerCase()) return;
  if ((await erased(store.listId, message.to)) !== false) return;
  const id = idOf(message.idempotencyKey);
  try {
    const [first] = await redisPipeline([["SET", toldKey(id), "1", "NX", "EX", OWED_MAIL_KEEP_SECONDS]]);
    if (first !== "OK") return;
  } catch (error) {
    // Not known whether they were told: not told twice.
    console.error("marking a creator told about an order email failed", error);
    return;
  }
  // The buyer's own email is not repeated here (it may hold a license key or a link to their purchase): only who it was for, what it was, and why it stopped.
  await firstTry(store, {
    from: NIMBUS_FROM,
    to,
    subject: `We could not email ${message.to.slice(0, 120)} about an order`.slice(0, 200),
    text: [
      `An email about an order on ${store.name || "your store"} could not be delivered to ${message.to}.`,
      SAID[why],
      `Its subject was: "${message.subject.slice(0, 200)}"`,
      "",
      "The order itself is recorded as usual. Please get in touch with them yourself, so they are not left waiting.",
    ].join("\n"),
    idempotencyKey: `nimbus-owed-told:${id}`,
  }, `${what}, its creator's notice`, true, null);
}

/**
 * The email job's pass (app/api/cron/mail): each owed email whose time came
 * is tried again, at most OWED_MAIL_PER_RUN a run and nothing started after
 * `deadline`. Its next time is moved on before it is tried (a lease), so a
 * run cut short never tries it again sooner.
 */
export async function sendOwedOrderMail(
  storeFor: (handle: string) => Promise<OwedStoreRead | null>,
  deadline: number,
): Promise<{ sent: number; owed: number; given: number }> {
  const counts = { sent: 0, owed: 0, given: 0 };
  if (!isRedisConfigured() || Date.now() >= deadline) return counts;
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", DUE, "-inf", now(), "LIMIT", 0, OWED_MAIL_PER_RUN]]);
  const members = stringList(raw);
  if (!members) {
    console.error("the owed order emails did not read; tried next run");
    return counts;
  }
  for (const member of members) {
    if (Date.now() >= deadline) break;
    const parts = MEMBER.exec(member);
    if (!parts) {
      await redisPipeline([["ZREM", DUE, member]]).catch(() => {});
      continue;
    }
    const [, id, owner] = parts;
    const [leased, value] = await redisPipeline([["ZADD", DUE, "XX", now() + OWED_MAIL_RETRY_SECONDS[OWED_MAIL_RETRY_SECONDS.length - 1], member], ["GET", mailKey(id)]]);
    if (countOf(leased) === null) continue;
    if (value === null) {
      // Gone by itself (kept past OWED_MAIL_KEEP_SECONDS): its store's place goes too (L2).
      await finish(id, owner);
      continue;
    }
    let entry: Owed | null = null;
    try {
      const parsed = JSON.parse(String(value)) as Owed;
      if (parsed && typeof parsed.h === "string" && parsed.s === owner && parsed.m && typeof parsed.m.to === "string" && typeof parsed.m.idempotencyKey === "string" && idOf(parsed.m.idempotencyKey) === id && kindKnown(parsed)) entry = parsed;
    } catch {}
    if (!entry) {
      console.error("an owed order email did not read; dropped", id);
      await finish(id, owner);
      continue;
    }
    const notice = entry.n === 1;
    const what = `an owed order ${notice ? "notice" : "email"} of ${entry.h}`;
    const store = await storeFor(entry.h).catch(() => null);
    const current: OwedStore = store ? { handle: store.handle, email: store.email, name: store.name, statsId: store.statsId, listId: store.listId } : { handle: entry.h, email: "", name: "", statsId: entry.s };
    // An erased person is never sent it (M1); not known, it waits for its next try.
    const gone = notice ? false : await erased(store?.listId, entry.m.to);
    if (gone === null) continue;
    if (gone) {
      console.error(`${what}: its address was erased from the store; dropped unsent`);
      await finish(id, owner);
      continue;
    }
    let figure: AllowanceStore | null = null;
    if (entry.k === "store" && entry.w) {
      // A creator's license-key notice is sent only while it is true, and only from its store's own figure: a store that
      // does not read whole, or a condition whose answer is not known, sends nothing now (tried at the lease's time).
      const holds = await stillHolds(entry.w);
      if (holds === false) {
        console.error(`${what}: a creator's notice is no longer true; let go unsent`);
        await finish(id, owner);
        continue;
      }
      figure = store && store.statsId === entry.s && allowanceStore(store) ? store : null;
      if (holds === null || !figure) {
        console.error(`${what}: a creator's notice could not be checked (${holds === null ? "its condition did not read" : "its store did not read"}); tried later`);
        continue;
      }
    }
    let outcome: SendOutcome;
    try {
      outcome = await sendEmailOutcome(figure ? asNotice(figure, entry.m) : asMessage(entry.m));
    } catch (error) {
      console.error(`${what}: the send threw; it may have gone, so it is not sent again`, error);
      outcome = "uncertain";
    }
    if (outcome === "sent") {
      counts.sent += 1;
      await finish(id, owner);
      continue;
    }
    if (outcome === "uncertain") {
      console.error(`${what}: the sender's answer is not known; it may have gone, so it is not sent again`);
      await finish(id, owner);
      continue;
    }
    if (await countRefusal(refusalName(entry.m), OWED_MAIL_KEEP_SECONDS)) {
      // Tried again at the time the lease above set: the second wait (OWED_MAIL_RETRY_SECONDS).
      counts.owed += 1;
      continue;
    }
    counts.given += 1;
    await finish(id, owner);
    await giveUp(current, entry.m, what, "tried", notice);
  }
  return counts;
}

/** An owed email's kind reads exactly: an order email, or a creator's license-key notice (n 1) with what must still be true. */
function kindKnown(entry: Owed): boolean {
  if (entry.k === undefined) return entry.w === undefined;
  if (entry.k !== "store" || entry.n !== 1 || !entry.w || typeof entry.w !== "object" || typeof entry.w.key !== "string" || !entry.w.key) return false;
  const w = entry.w as Record<string, unknown>;
  return Object.keys(w).length === 2 && (typeof w.field === "string" || typeof w.value === "string");
}

/** Whether a creator's notice is still true: true, false, or null when the answer is not in its exact shape. */
async function stillHolds(still: Still): Promise<boolean | null> {
  try {
    if ("field" in still) {
      const replies = repliesFor(await redisPipeline([["HEXISTS", still.key, still.field]]), 1);
      const count = replies ? countOf(replies[0]) : null;
      return count === 1 ? true : count === 0 ? false : null;
    }
    const replies = repliesFor(await redisPipeline([["GET", still.key]]), 1);
    if (!replies) return null;
    const [value] = replies;
    if (value === null) return false;
    return typeof value === "string" ? value === still.value : null;
  } catch {
    return null;
  }
}

/** A store read back whole enough for its email figure: its plan's fields, each in its type. */
function allowanceStore(store: OwedStoreRead): store is OwedStore & AllowanceStore {
  return typeof store.subscriptionActive === "boolean" && (store.subscriptionId === null || typeof store.subscriptionId === "string") &&
    typeof store.trialEnds === "number" && typeof store.planEndedAt === "string";
}
