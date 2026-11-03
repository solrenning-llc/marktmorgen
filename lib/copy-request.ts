/**
 * A person asking for a copy of what a store keeps about them, or every
 * store that knows them (619 [SZ3]): the mirror of the erasure's door
 * (lib/erasure-request.ts). The page is /privacy/copy.
 *
 * They type their address, and the store's name when they came from one.
 * If a store knows that address, a link is emailed to it; the page says the
 * same whether or not one does, so it cannot be used to learn who buys from
 * whom. The link works for an hour and lists the stores; for each, the copy
 * is made (lib/person-copy.ts) and kept COPY_KEEP_SECONDS, so asking again
 * within COPY_AGAIN_DAYS gives the same copy, not a new one.
 *
 * Its cost is never a store's (the owner's decision, inbox C3-5): before a
 * copy is made, the company's funded exposure for data copies is reserved
 * for that store and person (lib/exposure-budget.ts, "data_copy"). When it
 * cannot be, the request waits in a queue with the day it is due, and the
 * person is told that day; it is never refused. The link email is the
 * company's, bounded by the per-address and per-network limits.
 *
 *   nl:mycopy:link:<hash of a token>         { e: address, s: [store ids] }, an hour
 *   nl:mycopy:made:<store>:<person>           { n: parts, at }, COPY_KEEP_SECONDS
 *   nl:mycopy:made:<store>:<person>:<i>       one part of the made copy's JSON
 *   nl:mycopy:ask:<store>:<person>            { e: address, at, due } while it waits
 *   nl:mycopy:q                               "<store>|<person>" scored by when it is due
 */
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withinLimit } from "@/lib/request-guard";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { type Store, storeForHandle, storeForId } from "@/lib/store";
import { leadsKey } from "@/lib/contacts";
import { storesKnownFor } from "@/lib/buyer-library";
import { erasureScope } from "@/lib/person-erasure";
import { type PersonCopy, copyPerson } from "@/lib/person-copy";
import { reserveFundedExposure } from "@/lib/exposure-budget";
import { CURRENT_EXPOSURE_BUDGET_POLICY } from "@/lib/exposure-budget-policy";
import { COPY_COMPLETE } from "@/lib/person-copy";
import {
  COPY_ASKS_PER_ADDRESS_HOUR,
  COPY_ASKS_PER_IP_HOUR,
  COPY_KEEP_SECONDS,
  COPY_LINK_SECONDS,
  COPY_TOKEN,
  MAX_COPY_STORES,
  copyCase,
  copyDueDay,
} from "@/lib/copy-request-rules";

/**
 * Whether the door is open to anybody: the copy reads everything (no module
 * pending) and the company's exposure for copies is approved and funded, so a
 * request can be answered within the legal time, not only queued. While it is
 * closed the page and its route answer "not found" and the privacy policy
 * does not point to them (619 [SZ3]; nothing is shown that does not work).
 */
export const COPY_DOOR_OPEN = COPY_COMPLETE && CURRENT_EXPOSURE_BUDGET_POLICY !== null;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:mycopy:link:${sha(`nimbus-copy-link:${token}`).slice(0, 40)}`;
const personOf = (sid: string, email: string) => sha(`nimbus-copy-person:${sid}:${normaliseEmail(email)}`).slice(0, 32);
const madeKey = (sid: string, person: string) => `nl:mycopy:made:${sid}:${person}`;
const askKey = (sid: string, person: string) => `nl:mycopy:ask:${sid}:${person}`;
const QUEUE = "nl:mycopy:q";
const STORE_ID = /^[0-9a-f]{32}$/;
/** A made copy is kept in parts of this many characters, each one Redis value well under any request limit. */
export const COPY_PART_CHARS = 400_000;
/** The most parts one copy may take: twenty megabytes of one person's data in one store. */
export const MAX_COPY_PARTS = 50;

type Grant = { e: string; s: string[] };

export type CopyAsk = "sent" | "email" | "limited" | "error";

async function knows(store: Store, email: string, known: Set<string>): Promise<boolean> {
  if (store.sid && known.has(store.sid)) return true;
  if (!store.listId) return false;
  const [held] = await redisPipeline([["HEXISTS", leadsKey(store.listId), email]]);
  return Number(held) === 1;
}

/**
 * Emails a link to this address's copies from one store (by its address on
 * Marktmorgen) or from every store that knows it. "sent" whether or not any
 * does; nothing is sent when none does.
 */
export async function requestCopyLink(input: { email: string; ip: string; origin: string; handle?: string }): Promise<CopyAsk> {
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!isRedisConfigured() || !isSenderConfigured()) return "error";
  const email = normaliseEmail(raw);
  if (!(await withinLimit("copy-ip", input.ip, COPY_ASKS_PER_IP_HOUR, 3_600))) return "limited";
  if (!(await withinLimit("copy-address", sha(email), COPY_ASKS_PER_ADDRESS_HOUR, 3_600))) return "limited";
  const known = new Set(await storesKnownFor(email));
  const stores: Store[] = [];
  if (input.handle) {
    const store = await storeForHandle(input.handle).catch(() => null);
    if (store?.sid && (await knows(store, email, known))) stores.push(store);
  } else {
    for (const sid of [...known].slice(0, MAX_COPY_STORES)) {
      const store = await storeForId(sid).catch(() => null);
      if (store?.sid) stores.push(store);
    }
  }
  if (!stores.length) return "sent";
  const token = randomBytes(32).toString("hex");
  await redisPipeline([["SET", linkKey(token), JSON.stringify({ e: email, s: stores.map((s) => s.sid) } satisfies Grant), "EX", COPY_LINK_SECONDS]]);
  const names = stores.map((s) => s.name).slice(0, 10);
  const more = stores.length - names.length;
  const sent = await sendEmail({
    // The company's, never the store's (inbox C3-5): bounded by the limits above.
    meter: { by: "company" },
    from: NIMBUS_FROM,
    to: email,
    subject: stores.length === 1 ? `Your data from ${stores[0].name}` : "Your data from stores on Marktmorgen",
    text: [
      stores.length === 1
        ? `Someone asked for a copy of everything ${stores[0].name} keeps about this address on Marktmorgen.`
        : `Someone asked for a copy of everything these stores on Marktmorgen keep about this address: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`,
      "",
      "To get it, as a file you can read or take to another service, open this link within an hour:",
      "",
      `${input.origin}/privacy/copy?token=${token}`,
      "",
      "If you did not ask for this, ignore this email: nobody can get your data without this link.",
    ].join("\n"),
  });
  return sent ? "sent" : "error";
}

function parseGrant(raw: unknown): Grant | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Grant>;
    if (typeof v.e !== "string" || !EMAIL_PATTERN.test(v.e) || !Array.isArray(v.s)) return null;
    return { e: v.e, s: v.s.filter((s): s is string => typeof s === "string" && STORE_ID.test(s)).slice(0, MAX_COPY_STORES) };
  } catch {
    return null;
  }
}

/** The address a live link was sent to, and its stores; null when it has run out. */
export async function readCopyLink(token: string): Promise<{ email: string; stores: Store[] } | null> {
  if (!COPY_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", linkKey(token)]]);
  const grant = parseGrant(raw);
  if (!grant) return null;
  const stores = (await Promise.all(grant.s.map((sid) => storeForId(sid).catch(() => null)))).filter((s): s is Store => s !== null);
  return { email: grant.e, stores };
}

/** A made copy, read back whole; null when there is none or a part is missing. */
async function readMade(sid: string, person: string): Promise<PersonCopy | null> {
  const [head] = await redisPipeline([["GET", madeKey(sid, person)]]);
  if (typeof head !== "string") return null;
  try {
    const { n } = JSON.parse(head) as { n?: unknown };
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_COPY_PARTS) return null;
    const parts = await redisPipeline(Array.from({ length: n as number }, (_, i) => ["GET", `${madeKey(sid, person)}:${i}`]));
    if (parts.some((p) => typeof p !== "string")) return null;
    return JSON.parse(parts.join("")) as PersonCopy;
  } catch {
    return null;
  }
}

/** Keeps a made copy for COPY_KEEP_SECONDS, its parts first and its head last, so a head never names a part not written. */
async function keepMade(sid: string, person: string, copy: PersonCopy, now: number): Promise<void> {
  const text = JSON.stringify(copy);
  const n = Math.max(1, Math.ceil(text.length / COPY_PART_CHARS));
  if (n > MAX_COPY_PARTS) throw new Error("a copy too large to keep");
  await redisPipeline(Array.from({ length: n }, (_, i) => ["SET", `${madeKey(sid, person)}:${i}`, text.slice(i * COPY_PART_CHARS, (i + 1) * COPY_PART_CHARS), "EX", COPY_KEEP_SECONDS]));
  await redisPipeline([["SET", madeKey(sid, person), JSON.stringify({ n, at: Math.floor(now / 1000) }), "EX", COPY_KEEP_SECONDS]]);
}

export type CopyResult =
  /** The copy, made now or kept from a request in the last COPY_AGAIN_DAYS. */
  | { state: "ready"; copy: PersonCopy; again: boolean }
  /** Waiting for the company's exposure: made by `due` (an ISO day) at the latest. */
  | { state: "queued"; due: string }
  /** The link ran out, or the store is not on it. */
  | { state: "gone" };

/**
 * The copy of one store on a live link: the one already made in the last
 * COPY_AGAIN_DAYS, or a new one when the company's exposure for it can be
 * reserved; otherwise the request waits in the queue, with its day.
 * `reserve` is the exposure's reservation (lib/exposure-budget.ts); passed
 * in so a test can stand for the company's reviewed budget.
 */
export async function copyFor(
  token: string,
  sid: string,
  now = Date.now(),
  reserve: (caseId: string) => Promise<boolean> = (caseId) => reserveFundedExposure(caseId, "data_copy"),
): Promise<CopyResult> {
  if (!COPY_TOKEN.test(token) || !STORE_ID.test(sid) || !isRedisConfigured()) return { state: "gone" };
  const [raw] = await redisPipeline([["GET", linkKey(token)]]);
  const grant = parseGrant(raw);
  if (!grant || !grant.s.includes(sid)) return { state: "gone" };
  const person = personOf(sid, grant.e);
  const kept = await readMade(sid, person);
  if (kept) return { state: "ready", copy: kept, again: true };
  return makeOrQueue(sid, person, grant.e, now, reserve);
}

async function makeOrQueue(sid: string, person: string, email: string, now: number, reserve: (caseId: string) => Promise<boolean>): Promise<CopyResult> {
  const store = await storeForId(sid).catch(() => null);
  if (!store) return { state: "gone" };
  if (!(await reserve(copyCase(sid, person)).catch(() => false))) {
    // Waits, with the day it is due from the first time it was asked; never refused.
    const asked = { e: normaliseEmail(email), at: now, due: copyDueDay(now) };
    await redisPipeline([["SET", askKey(sid, person), JSON.stringify(asked), "NX", "EX", COPY_KEEP_SECONDS + 86_400]]);
    const [held] = await redisPipeline([["GET", askKey(sid, person)]]);
    const first = (() => {
      try {
        return JSON.parse(String(held)) as { at: number; due: string };
      } catch {
        return asked;
      }
    })();
    await redisPipeline([["ZADD", QUEUE, "NX", Date.parse(`${first.due}T00:00:00Z`), `${sid}|${person}`]]);
    return { state: "queued", due: first.due };
  }
  const scope = store.statsId && store.listId ? await erasureScope(store, normaliseEmail(email)) : null;
  const copy: PersonCopy = scope
    ? await copyPerson(scope, now)
    : { store: { name: store.name, handle: store.handle }, email: normaliseEmail(email), made: new Date(now).toISOString(), sections: [], marks: [], elsewhere: [] };
  await keepMade(sid, person, copy, now);
  await redisPipeline([["DEL", askKey(sid, person)], ["ZREM", QUEUE, `${sid}|${person}`]]);
  return { state: "ready", copy, again: false };
}

/** Requests waiting in the queue, soonest due first: for the job that answers them (and for the owner's view of it). */
export async function queuedCopies(limit = 50): Promise<{ sid: string; person: string; due: number }[]> {
  if (!isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", QUEUE, "-inf", "+inf", "WITHSCORES", "LIMIT", 0, limit]]);
  const flat = Array.isArray(raw) ? raw.map(String) : [];
  const out: { sid: string; person: string; due: number }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const [sid, person] = flat[i].split("|");
    if (STORE_ID.test(sid ?? "") && /^[0-9a-f]{32}$/.test(person ?? "")) out.push({ sid, person, due: Number(flat[i + 1]) || 0 });
  }
  return out;
}
