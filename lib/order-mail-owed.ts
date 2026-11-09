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
 */
import { createHash } from "node:crypto";
import { NIMBUS_FROM, type SendOutcome, sendEmailOutcome } from "@/lib/email";
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
 * share of the due read, the lease ZADD, GET, the refusal's INCR and EXPIRE:
 * 5) and its end (DEL, ZREM, SREM, the told mark: 4); measured in
 * tests/order-mail-owed.test.ts. A key that ran out unread leaves its id in
 * its store's set until that set's own expiry (OWED_MAIL_KEEP_SECONDS after
 * the store's last owed email).
 */
export const OWED_MAIL_COMMANDS = 7 + (REFUSED_TRIES - 1) * 5 + 4;

const DUE = "nl:owedmail:due";
const idOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
const mailKey = (id: string) => `nl:owedmail:m:${id}`;
const storeKey = (store: string) => `nl:owedmail:s:${store}`;
const toldKey = (id: string) => `nl:owedmail:told:${id}`;
const ID = /^[0-9a-f]{32}$/;
const now = () => Math.floor(Date.now() / 1000);

type Owed = { h: string; s: string; m: OrderMessage; t: number };

const asMessage = (message: OrderMessage) => ({ meter: { by: "order" } as const, ...message });
/** The name its refusals are counted under (lib/refused-tries.ts): the email's own key. */
const refusalName = (message: OrderMessage) => `owedmail:${message.idempotencyKey}`;
const storeOf = (store: OwedStore) => store.statsId || store.handle;

/**
 * Sends one order email, and keeps it owed when a sender refused it for
 * certain (above). Never throws for the email's sake: the order is written
 * already, and its caller goes on.
 */
export async function sendOrderMail(store: OwedStore, message: OrderMessage, what: string): Promise<SendOutcome> {
  let outcome: SendOutcome;
  try {
    outcome = await sendEmailOutcome(asMessage(message));
  } catch (error) {
    // Thrown after it may have been handed over: never sent again.
    console.error(`${what}: the send threw; it may have gone, so it is not sent again`, error);
    return "uncertain";
  }
  if (outcome === "uncertain") console.error(`${what}: the sender's answer is not known; it may have gone, so it is not sent again`);
  if (outcome !== "refused") return outcome;
  // The first of its REFUSED_TRIES (lib/refused-tries.ts): a count that does not read is the limit.
  if (!(await countRefusal(refusalName(message), OWED_MAIL_KEEP_SECONDS))) {
    await giveUp(store, message, what, "refused, and its count of tries is spent or does not read");
    return outcome;
  }
  const kept = await owe(store, message, OWED_MAIL_RETRY_SECONDS[0]);
  if (kept !== "kept") await giveUp(store, message, what, kept);
  else console.error(`${what}: refused for certain; kept to be tried again`);
  return outcome;
}

/** Writes the email down as owed, tried again `after` seconds from now. */
async function owe(store: OwedStore, message: OrderMessage, after: number): Promise<"kept" | string> {
  if (!isRedisConfigured()) return "no database to keep it in";
  const owner = storeOf(store);
  if (!owner) return "no store to keep it under";
  const id = idOf(message.idempotencyKey);
  const entry: Owed = { h: store.handle, s: owner, m: message, t: now() };
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
 * address that refused it would be refused too): logged only.
 */
async function giveUp(store: OwedStore, message: OrderMessage, what: string, why: string): Promise<void> {
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
  storeFor: (handle: string) => Promise<OwedStore | null>,
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
      if (parsed && typeof parsed.h === "string" && typeof parsed.s === "string" && parsed.m && typeof parsed.m.to === "string" && typeof parsed.m.idempotencyKey === "string" && idOf(parsed.m.idempotencyKey) === id) entry = parsed;
    } catch {}
    if (!entry) {
      console.error("an owed order email did not read; dropped", id);
      await finish(id, "");
      continue;
    }
    const what = `an owed order email of ${entry.h}`;
    const store = await storeFor(entry.h).catch(() => null);
    const owner: OwedStore = store ? { handle: store.handle, email: store.email, name: store.name, statsId: store.statsId } : { handle: entry.h, email: "", name: "", statsId: entry.s };
    let outcome: SendOutcome;
    try {
      outcome = await sendEmailOutcome(asMessage(entry.m));
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
    await giveUp(owner, entry.m, what, `refused ${REFUSED_TRIES} times`);
  }
  return counts;
}
