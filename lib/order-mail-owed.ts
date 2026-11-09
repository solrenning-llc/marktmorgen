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
 *              (app/api/cron/mail), after OWED_MAIL_RETRY_SECONDS, until it
 *              is sent, its answer is not known, or it was refused
 *              REFUSED_TRIES times in all (lib/refused-tries.ts, the count
 *              every caller that asks again shares); then the creator is
 *              told once, so the buyer still hears from them.
 *
 * Every try keeps the email's own idempotency key, so a sender that took an
 * earlier try never sends it twice.
 *
 * Keys (one family, nl:owedmail:):
 *
 *   nl:owedmail:due        sorted set for every store: an owed email's id,
 *                          scored by when it is tried next (never an address)
 *   nl:owedmail:m:<id>     the email as written, with its store's handle,
 *                          OWED_MAIL_KEEP_SECONDS at most
 *   nl:owedmail:s:<store>  the ids a store owes, OWED_MAIL_PER_STORE at most
 *   nl:owedmail:told:<id>  the creator was told this one was given up
 *
 * <id> is a hash of the email's idempotency key. A store owing
 * OWED_MAIL_PER_STORE already, an email over OWED_MAIL_MAX_BYTES, or a write
 * that does not answer as it should is given up at once, and the creator is
 * told: never kept past the bound, never silently lost.
 *
 * A creator's own notice about an order (sendStoreNotice: a buyer waits for
 * a license key, the pool of keys runs low, lib/licence-keys.ts; rule 30 of
 * EM1) is owed the same way, with two differences: every try is taken from
 * the store's own email figure (meter "store"), as the notice always was, so
 * a notice that is sent takes it once and N certain refusals take it at most
 * REFUSED_TRIES times (lib/refused-tries.ts); and it carries what must still
 * be true for it to be sent (`still`: the buyer still waits, the pool's
 * warning is still the one claimed), read before each try again, so a notice
 * no longer true is let go unsent and takes nothing. Given up, it is logged
 * only: the creator is the one it could not reach.
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
/** The store an order email is for: who is told when it is given up, and where the cap is counted. */
export type OwedStore = { statsId?: string | null; handle: string; email: string; name: string };
/** A store as the email job reads it back: its plan's fields too, when a creator's notice is taken from its figure. */
export type OwedStoreRead = OwedStore & Partial<AllowanceStore>;
/** What must still be true for a creator's notice to be sent: a hash's field still there, or a key still holding the value claimed. */
export type Still = { key: string; field: string } | { key: string; value: string };
/** A creator's own notice about an order (sendStoreNotice): an order email's shape, with what must still be true. */
export type StoreNotice = OrderMessage & { still: Still };

/** Emails a store may owe at once; one more is given up, and its creator told. */
export const OWED_MAIL_PER_STORE = 20;
/** The most one owed email may weigh as kept (its text and a calendar file); one heavier is given up, and its creator told. */
export const OWED_MAIL_MAX_BYTES = 16 * 1024;
/** How long an owed email is kept: past its last try (OWED_MAIL_RETRY_SECONDS) with room for a late run. */
export const OWED_MAIL_KEEP_SECONDS = 2 * 86_400;
/** When it is tried again, after its first refusal and after its second (REFUSED_TRIES in all): past a paused sender's ten minutes, then hours later. */
export const OWED_MAIL_RETRY_SECONDS: readonly number[] = [15 * 60, 3 * 3600];
/** Owed emails one run of the email job tries at most. */
export const OWED_MAIL_PER_RUN = 25;
/**
 * Commands one owed email may take in all, besides its sends (each an order
 * email, lib/email.ts): its first refusal counted and the email kept (INCR,
 * EXPIRE; SADD, SCARD, EXPIRE, SET, ZADD: 7), each of its tries again (its
 * share of the due read, the lease ZADD, GET, the refusal's INCR and EXPIRE,
 * and for a creator's notice the read of what must still be true: 6) and its
 * end (DEL, ZREM, SREM, the told mark: 4); measured in
 * tests/order-mail-owed.test.ts. A key that ran out unread leaves its id in
 * its store's set until that set's own expiry (OWED_MAIL_KEEP_SECONDS after
 * the store's last owed email).
 */
export const OWED_MAIL_COMMANDS = 7 + (REFUSED_TRIES - 1) * 6 + 4;

const DUE = "nl:owedmail:due";
const idOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
const mailKey = (id: string) => `nl:owedmail:m:${id}`;
const storeKey = (store: string) => `nl:owedmail:s:${store}`;
const toldKey = (id: string) => `nl:owedmail:told:${id}`;
const ID = /^[0-9a-f]{32}$/;
const now = () => Math.floor(Date.now() / 1000);

/** An owed email as kept: `k` "store" and `w` for a creator's notice, taken from its store's figure while `w` holds. */
type Owed = { h: string; s: string; m: OrderMessage; t: number; k?: "store"; w?: Still };

const asMessage = (message: OrderMessage) => ({ meter: { by: "order" } as const, ...message });
const asNotice = (store: AllowanceStore, message: OrderMessage) => ({ meter: { by: "store", store, kind: "email" } as const, ...message });
/** The name its refusals are counted under (lib/refused-tries.ts): the email's own key. */
const refusalName = (message: OrderMessage) => `owedmail:${message.idempotencyKey}`;
const storeOf = (store: OwedStore) => store.statsId || store.handle;

/**
 * Sends one order email, and keeps it owed when a sender refused it for
 * certain (above). Never throws for the email's sake: the order is written
 * already, and its caller goes on.
 */
export async function sendOrderMail(store: OwedStore, message: OrderMessage, what: string): Promise<SendOutcome> {
  return sendOwed(store, message, what, null);
}

/**
 * Sends a creator's own notice about an order (above), from the store's own
 * email figure, and keeps it owed, with what must still be true for it, when
 * a sender refused it for certain. Never throws for the notice's sake.
 */
export async function sendStoreNotice(store: OwedStore & AllowanceStore, notice: StoreNotice, what: string): Promise<SendOutcome> {
  const { still, ...message } = notice;
  return sendOwed(store, message, what, { store, still });
}

async function sendOwed(store: OwedStore, message: OrderMessage, what: string, notice: { store: AllowanceStore; still: Still } | null): Promise<SendOutcome> {
  let outcome: SendOutcome;
  try {
    outcome = await sendEmailOutcome(notice ? asNotice(notice.store, message) : asMessage(message));
  } catch (error) {
    // Thrown after it may have been handed over: never sent again.
    console.error(`${what}: the send threw; it may have gone, so it is not sent again`, error);
    return "uncertain";
  }
  if (outcome === "uncertain") console.error(`${what}: the sender's answer is not known; it may have gone, so it is not sent again`);
  if (outcome !== "refused") return outcome;
  // The first of its REFUSED_TRIES (lib/refused-tries.ts): a count that does not read is the limit.
  if (!(await countRefusal(refusalName(message), OWED_MAIL_KEEP_SECONDS))) {
    await giveUp(store, message, what, "refused, and its count of tries is spent or does not read", Boolean(notice));
    return outcome;
  }
  const kept = await owe(store, message, OWED_MAIL_RETRY_SECONDS[0], notice?.still ?? null);
  if (kept !== "kept") await giveUp(store, message, what, kept, Boolean(notice));
  else console.error(`${what}: refused for certain; kept to be tried again`);
  return outcome;
}

/** Writes the email down as owed, tried again `after` seconds from now. */
async function owe(store: OwedStore, message: OrderMessage, after: number, still: Still | null): Promise<"kept" | string> {
  if (!isRedisConfigured()) return "no database to keep it in";
  const owner = storeOf(store);
  if (!owner) return "no store to keep it under";
  const id = idOf(message.idempotencyKey);
  const entry: Owed = { h: store.handle, s: owner, m: message, t: now(), ...(still ? { k: "store" as const, w: still } : {}) };
  const json = JSON.stringify(entry);
  if (Buffer.byteLength(json) > OWED_MAIL_MAX_BYTES) return `heavier than ${OWED_MAIL_MAX_BYTES} bytes`;
  try {
    // The store's place first, read back: past the cap the place is given back and nothing else is written.
    const placed = repliesFor(await redisPipeline([["SADD", storeKey(owner), id], ["SCARD", storeKey(owner)], ["EXPIRE", storeKey(owner), OWED_MAIL_KEEP_SECONDS]]), 3);
    const added = placed ? countOf(placed[0]) : null;
    const count = placed ? countOf(placed[1]) : null;
    if (added === null || count === null) return "its store's count did not read";
    if (count > OWED_MAIL_PER_STORE) {
      if (added === 1) await redisPipeline([["SREM", storeKey(owner), id]]).catch(() => {});
      return `its store owes ${OWED_MAIL_PER_STORE} already`;
    }
    const written = repliesFor(await redisPipeline([["SET", mailKey(id), json, "EX", OWED_MAIL_KEEP_SECONDS], ["ZADD", DUE, now() + after, id]]), 2);
    if (!written || written[0] !== "OK" || countOf(written[1]) === null) return "it could not be written";
    return "kept";
  } catch (error) {
    console.error("keeping an owed order email failed", error);
    return "it could not be written";
  }
}

/** Takes an owed email off every list: sent, its answer not known, or given up. */
async function finish(id: string, owner: string): Promise<void> {
  await redisPipeline([["DEL", mailKey(id)], ["ZREM", DUE, id], ...(owner ? [["SREM", storeKey(owner), id]] : [])]).catch((error) =>
    console.error("taking an owed order email off its list failed", error),
  );
}

/**
 * Gives an order email up: logged, and its creator told once, so the buyer
 * hears from them. Not when the email was the creator's own (telling the
 * address that refused it would be refused too), nor a creator's notice
 * (sendStoreNotice: it was to them): logged only.
 */
async function giveUp(store: OwedStore, message: OrderMessage, what: string, why: string, notice = false): Promise<void> {
  if (notice) {
    console.error(`${what}: a creator's notice could not be sent (${why}); given up`);
    return;
  }
  console.error(`${what}: an order email to the buyer or host could not be sent (${why}); its creator is told`);
  const to = store.email.trim();
  if (!to || to.toLowerCase() === message.to.trim().toLowerCase()) return;
  const id = idOf(message.idempotencyKey);
  try {
    const [first] = await redisPipeline([["SET", toldKey(id), "1", "NX", "EX", OWED_MAIL_KEEP_SECONDS]]);
    if (first !== "OK") return;
  } catch (error) {
    // Not known whether they were told: not told twice.
    console.error("marking a creator told about an order email failed", error);
    return;
  }
  // The buyer's own email is not repeated here (it may hold a license key or a link to their purchase): only who it was for and what it was.
  const outcome = await sendEmailOutcome({
    meter: { by: "order" },
    from: NIMBUS_FROM,
    to,
    subject: `We could not email ${message.to.slice(0, 120)} about an order`.slice(0, 200),
    text: [
      `An email about an order on ${store.name || "your store"} could not be delivered to ${message.to}. We tried and stopped, so it is not sent twice.`,
      `Its subject was: "${message.subject.slice(0, 200)}"`,
      "",
      "The order itself is recorded as usual. Please get in touch with them yourself, so they are not left waiting.",
    ].join("\n"),
    idempotencyKey: `nimbus-owed-told:${id}`,
  }).catch(() => "uncertain" as const);
  if (outcome !== "sent") console.error(`${what}: telling the creator about it was not sent (${outcome})`);
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
  const ids = stringList(raw);
  if (!ids) {
    console.error("the owed order emails did not read; tried next run");
    return counts;
  }
  for (const id of ids) {
    if (Date.now() >= deadline) break;
    if (!ID.test(id)) {
      await redisPipeline([["ZREM", DUE, id]]).catch(() => {});
      continue;
    }
    const [leased, value] = await redisPipeline([["ZADD", DUE, "XX", now() + OWED_MAIL_RETRY_SECONDS[OWED_MAIL_RETRY_SECONDS.length - 1], id], ["GET", mailKey(id)]]);
    if (countOf(leased) === null) continue;
    if (value === null) {
      // Gone by itself (kept past OWED_MAIL_KEEP_SECONDS): its store's place goes with its own key.
      await finish(id, "");
      continue;
    }
    let entry: Owed | null = null;
    try {
      const parsed = JSON.parse(String(value)) as Owed;
      if (parsed && typeof parsed.h === "string" && typeof parsed.s === "string" && parsed.m && typeof parsed.m.to === "string" && typeof parsed.m.idempotencyKey === "string" && idOf(parsed.m.idempotencyKey) === id && kindKnown(parsed)) entry = parsed;
    } catch {}
    if (!entry) {
      console.error("an owed order email did not read; dropped", id);
      await finish(id, "");
      continue;
    }
    const what = `an owed order email of ${entry.h}`;
    const store = await storeFor(entry.h).catch(() => null);
    const owner: OwedStore = store ? { handle: store.handle, email: store.email, name: store.name, statsId: store.statsId } : { handle: entry.h, email: "", name: "", statsId: entry.s };
    const notice = entry.k === "store" && entry.w ? entry.w : null;
    let figure: AllowanceStore | null = null;
    if (notice) {
      // A creator's notice is sent only while it is true, and only from its store's own figure: a store that does not
      // read whole, or a condition whose answer is not known, sends nothing now (tried at the lease's time, until it runs out).
      const holds = await stillHolds(notice);
      if (holds === false) {
        console.error(`${what}: a creator's notice is no longer true; let go unsent`);
        await finish(id, entry.s);
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
      await finish(id, entry.s);
      continue;
    }
    if (outcome === "uncertain") {
      console.error(`${what}: the sender's answer is not known; it may have gone, so it is not sent again`);
      await finish(id, entry.s);
      continue;
    }
    if (await countRefusal(refusalName(entry.m), OWED_MAIL_KEEP_SECONDS)) {
      // Tried again at the time the lease above set: the second wait (OWED_MAIL_RETRY_SECONDS).
      counts.owed += 1;
      continue;
    }
    counts.given += 1;
    await finish(id, entry.s);
    await giveUp(owner, entry.m, what, `refused ${REFUSED_TRIES} times`, Boolean(notice));
  }
  return counts;
}

/** An owed email's kind reads exactly: an order email, or a creator's notice with what must still be true. */
function kindKnown(entry: Owed): boolean {
  if (entry.k === undefined) return entry.w === undefined;
  if (entry.k !== "store" || !entry.w || typeof entry.w !== "object" || typeof entry.w.key !== "string" || !entry.w.key) return false;
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
