/**
 * Waitlists, kept (the rules are in lib/waitlist-rules.ts).
 *
 *   nl:wl:<store>:soon          set    products coming soon
 *   nl:wl:<store>:<product>     hash   address → WaitEntry
 *   nl:wl:<store>:<product>:job string the launch email, while it goes out and for 90 days after
 *   nl:wl:<store>:<product>:send list   who the launch email goes to, fixed when it starts
 *   nl:wl:t:<sha(token)>        string what a confirm or leave link is for
 *   nl:wl:jobs                  set    launches still sending: "<store>|<product>"
 *
 * <store> is the store's statsId, which stays through a change of handle.
 */
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { withinStore } from "@/lib/metered-limits";
import { createHash } from "node:crypto";
import { WAIT_TOKEN, newWaitlistToken as newToken, waitlistTokenKey as tokenKey, parseStoreWaitlistGrant, type StoreWaitlistGrant as TokenGrant } from "@/lib/waitlist-tokens";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, countData, dataKey, giveData, noteData, takeData } from "@/lib/store-data";
import { HASH_SWAP_IF, HASH_TAKE_ALL, HASH_TAKE_FIELD, takenPairs } from "@/lib/redis-take";
import { UnknownReply, exactReplies, plainList } from "@/lib/redis-exact";
import { dataBytes } from "@/lib/store-data-rules";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, sendBatch, sendEmail } from "@/lib/email";
import { withinLimit } from "@/lib/request-guard";
import { fromLine, mailDay, releaseDay, render, reserveDay } from "@/lib/mail";
import { upsertContact } from "@/lib/contacts";
import { SITE_URL } from "@/lib/site-url";
import { handleLeadsToStore, storeHandleKey, type Listing, type Store } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { listingSizes, productIds } from "@/lib/catalog";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import {
  CONFIRM_SECONDS,
  LAUNCH_BATCH,
  LAUNCH_HOLD_SECONDS,
  type LaunchJob,
  MAX_LAUNCH_ADDRESS,
  MAX_LAUNCH_NOTE,
  MAX_WAITLIST,
  WAIT_SECONDS,
  type WaitEntry,
  launchBody,
  parseEntry,
  parseJob,
} from "@/lib/waitlist-rules";
import { cleanText, cleanLine } from "@/lib/community-text";
import { productSegment } from "@/lib/product-slug";
import { noteForErasure } from "@/lib/erasure-index";
import { blankInLists } from "@/lib/erasure-lists";
import { erasedWithinCommand } from "@/lib/suppression";

const soonKey = (sid: string) => `nl:wl:${sid}:soon`;
const listKey = (sid: string, pid: string) => `nl:wl:${sid}:${pid}`;
const jobKey = (sid: string, pid: string) => `nl:wl:${sid}:${pid}:job`;
const sendKey = (sid: string, pid: string) => `nl:wl:${sid}:${pid}:send`;
const JOBS = "nl:wl:jobs";
/**
 * How long a launch's record and its send list are kept from their last
 * write: the same for both, renewed together (launch, every batch, every held
 * run), so the list never lapses while its record lives, and as long as the
 * hold (LAUNCH_HOLD_SECONDS), so a held launch's record lives until its stop.
 */
const JOB_SECONDS = LAUNCH_HOLD_SECONDS;
/**
 * The hold's last week: a renewal read in another shape here stops the launch
 * at once (holdLaunch), while its record still certainly lives, rather than
 * leave it to lapse with nobody told.
 */
const HOLD_LAST_STRETCH = 7 * 86_400;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => Math.floor(Date.now() / 1000);

export { WAIT_TOKEN };

function sender(store: Store): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  const address = (match ? match[1] : NIMBUS_FROM).trim();
  const name = store.name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
  return `"${name} via Marktmorgen" <${address}>`;
}

// ------------------------------------------------------------------ coming soon

/**
 * The products of a store that are coming soon, for its pages. A reply that is
 * not exactly a list of text (none, another shape, a hole, a lost pipeline) is
 * unknown, never an empty set: it throws, so no caller can take a product whose
 * state could not be read for one already on sale (rule 24).
 */
export async function soonProducts(store: Store): Promise<Set<string>> {
  if (!store.statsId || !isRedisConfigured()) return new Set();
  const members = stringList(repliesFor(await redisPipeline([["SMEMBERS", soonKey(store.statsId)]]), 1)?.[0]);
  if (!members) throw new UnknownReplyError("the products coming soon");
  return new Set(members);
}

/** Whether one product is coming soon: 0 or 1 only, as lib/preorders.ts reads it; anything else throws as unknown (rule 24). */
export async function isSoon(store: Store, productId: string): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const raw = repliesFor(await redisPipeline([["SISMEMBER", soonKey(store.statsId), productId]]), 1)?.[0];
  if (raw === 1 || raw === "1") return true;
  if (raw === 0 || raw === "0") return false;
  throw new UnknownReplyError("whether a product is coming soon");
}

export async function setSoon(store: Store, productId: string, on: boolean): Promise<void> {
  if (!store.statsId) return;
  await redisPipeline([[on ? "SADD" : "SREM", soonKey(store.statsId), productId]]);
}

// ------------------------------------------------------------------ joining

export type JoinResult = "sent" | "email" | "limited" | "full" | "closed" | "error";

/**
 * Takes an address for a product's waitlist and emails it a button to
 * confirm. Nothing counts until that button is pressed.
 */
export async function joinWaitlist(input: {
  store: Store;
  product: Listing;
  email: string;
  consent: boolean;
  /** The second box, allowing their link use in sequences to be seen; only with the first. */
  clicks?: boolean;
  ip: string;
  origin: string;
}): Promise<JoinResult> {
  const { store, product, consent, ip, origin } = input;
  // Switched off after notices about its content (lib/takedown.ts): no address is taken, as on its list.
  if (store.suspended) return "closed";
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!store.statsId || !isRedisConfigured()) return "error";
  if (!(await isSoon(store, product.id))) return "closed";
  const email = normaliseEmail(raw);
  const sid = store.statsId;
  if (!(await withinStore("waitlist-ip", `${sid}:${ip}`, 10, 3_600, store))) return "limited";
  if (!(await withinLimit("waitlist-address", sha(email), 5, 3_600))) return "limited";

  const startedAt = Math.floor(Date.now() / 1000);
  const confirm = newToken();
  const grant = (k: TokenGrant["k"], t: string): (string | number)[] => ["SET", tokenKey(t), JSON.stringify({ s: sid, h: store.handle, p: product.id, e: email, k } satisfies TokenGrant), "EX", k === "confirm" ? CONFIRM_SECONDS : WAIT_SECONDS];
  // The links go before the place, noted for a deletion of the person: one
  // that runs in between deletes them too, and never leaves a link with the
  // address on it or a link to leave nobody counted.
  // Every reply read exactly (Codex G, MEDIUM): a link is never emailed unless both grants and their deletion notes are
  // there. False is not known to be unwritten: the caller deletes the tokens it made and gives back what it took.
  const links = async (leave: string): Promise<boolean> => {
    const commands = [grant("confirm", confirm), grant("leave", leave), ...noteForErasure(sid, email, tokenKey(confirm)), ...noteForErasure(sid, email, tokenKey(leave))];
    const replies = repliesFor(await redisPipeline(commands), commands.length);
    if (!replies) return false;
    return commands.every((command, i) => {
      if (command[0] === "SET") return replies[i] === "OK";
      const count = countOf(replies[i]);
      if (count === null) return false;
      if (command[0] === "ZADD") return count <= 1;
      if (command[0] === "EXPIRE") return count === 1;
      return command[0] === "ZREMRANGEBYSCORE";
    });
  };

  // A place written by another request between the read and the write (a
  // double click) is read again and asked again; one deleted in between is
  // not made again.
  let leave = "";
  let mustExist = false;
  let lastLink = "";
  for (let tries = 0; tries < 3 && !leave; tries += 1) {
    // Read exactly (Claude 4 cloud R on #3707): a size that is not a whole count would be NaN, and NaN is never at
    // the ceiling, so the public list would grow past it; a place of another shape is not "absent". Either is unknown.
    const read = repliesFor(
      await redisPipeline([
        ["HGET", listKey(sid, product.id), email],
        ["HLEN", listKey(sid, product.id)],
      ]),
      2,
    );
    const existing = read?.[0];
    const size = countOf(read?.[1]);
    if (!read || size === null || (existing !== null && typeof existing !== "string")) return "error";
    if (typeof existing !== "string") {
      if (mustExist) {
        // Deleted in between: the links this request wrote go with it.
        await redisPipeline([["DEL", tokenKey(confirm), ...(lastLink ? [tokenKey(lastLink)] : [])]]);
        return "error";
      }
      if (size >= MAX_WAITLIST) return "full";
      const t = newToken();
      const value = JSON.stringify({ at: now(), ok: 0, c: consent, ...(consent && input.clicks ? { k: true } : {}), t, w: 1 } satisfies WaitEntry);
      // A new address takes room in the store's data room, with its link to leave
      // (kept as long as the list); with no room the list is full for it.
      const taken = placeBytes(sid, product.id, email, value);
      if (!(await takeData(store, [{ slot: waitSlot(product.id), bytes: taken }])).ok) return "full";
      if (!(await links(t))) {
        // Not proved: this request's two tokens go (best effort), and so does the room it took for the place.
        await redisPipeline([["DEL", tokenKey(confirm), tokenKey(t)]]).catch(() => {});
        await giveData(store, [{ slot: waitSlot(product.id), bytes: taken }]);
        return "error";
      }
      const [added] = await redisPipeline([["HSETNX", listKey(sid, product.id), email, value]]);
      if (added === 1) {
        leave = t;
        break;
      }
      if (added !== 0) {
        // Not known whether it was written: its room stays taken, since the place may be there (Claude 5 on #2576),
        // and it reads again. Written, the place is found as it is and kept; not written, its links go and it fails.
        lastLink = t;
        mustExist = true;
        continue;
      }
      // Another request wrote it first (an exact 0): this one's room and its unused link to leave go, and it asks again.
      await giveData(store, [{ slot: waitSlot(product.id), bytes: taken }]);
      await redisPipeline([["DEL", tokenKey(t)]]);
      mustExist = true;
      continue;
    }
    // Asked again: written only over the place as it was read, counted at what
    // it changed.
    const before = parseEntry(existing);
    if (!before) {
      // A place kept as text that does not read is unknown (#4792), never "not on the list": written over as a new one,
      // it would lose a confirmed place and its leave token, take data room again and send a new confirmation. It is
      // left as it is and nothing is sent; a link to confirm this request already wrote goes.
      if (mustExist) await redisPipeline([["DEL", tokenKey(confirm)]]);
      return "error";
    }
    const t = before.t;
    const asked = Boolean(before.c) || consent;
    // How its link was counted stays with the place (WaitEntry.w): an older place is never counted again as a new one.
    const value = JSON.stringify({ at: before.at, ok: before.ok, c: asked, ...(asked && (before.k || (consent && input.clicks)) ? { k: true } : {}), t, ...(before.w ? { w: 1 } : {}) } satisfies WaitEntry);
    // Its growth counted before it is written (countEntryGrowth): a count not confirmed writes nothing, and a link to
    // confirm this request already wrote goes, as for a place that does not read.
    const grown = await countEntryGrowth(store, sid, product.id, email, existing, value);
    if (grown === null) {
      if (mustExist) await redisPipeline([["DEL", tokenKey(confirm)]]);
      return "error";
    }
    if (!(await links(t))) {
      // Not proved: the new link to confirm goes; the place's own link to leave stays, and nothing was written over it,
      // so what was counted for its growth goes back.
      await redisPipeline([["DEL", tokenKey(confirm)]]).catch(() => {});
      await settleEntryWrite(store, product.id, grown, 0);
      return "error";
    }
    lastLink = t;
    const [swapped] = await redisPipeline([["EVAL", HASH_SWAP_IF, 1, listKey(sid, product.id), email, existing, value]]);
    await settleEntryWrite(store, product.id, grown, swapped);
    if (swapped === 1) {
      leave = t;
      break;
    }
    // Not known whether it was written: what was counted for it stays, never given back, and it reads again.
    mustExist = true;
  }
  if (!leave) {
    // Changed under it every time: its link to confirm leads nowhere and goes.
    await redisPipeline([["DEL", tokenKey(confirm)]]);
    return "error";
  }

  // A deletion of the person that began while this request ran takes its
  // places before the links it noted: a place written between the two would
  // be left with the address on it. The deletion's first step is the
  // address's fingerprint, with its time (lib/suppression.ts), so a place
  // written now, under a fingerprint that recent, is taken back with its
  // links and room, and nothing is sent. ERASURE_SECONDS is how long a
  // deletion may still be running; an address deleted that recently is
  // asked to try again later.
  if (store.listId) {
    // Judged on Redis's clock alone (Claude 1 cloud's LEVE on #2576): the mark is written in seconds of Redis's TIME,
    // and read against TIME in the same step, over ERASURE_SECONDS and how long this request has run (a duration, so
    // no instance's clock is ever compared with Redis's). Only an exact 0 is "not deleted that recently"; a mark that
    // is not whole seconds (-1) or a missing or other reply is unknown and taken as a recent deletion (rule 24).
    const ran = Math.max(0, Math.ceil(Date.now() / 1000) - startedAt);
    const recent = repliesFor(await redisPipeline([erasedWithinCommand(store.listId, email, ERASURE_SECONDS + ran)]), 1)?.[0];
    if (recent !== 0) {
      const [taken] = await redisPipeline([["EVAL", HASH_TAKE_FIELD, 1, listKey(sid, product.id), email], ["DEL", tokenKey(confirm), tokenKey(leave)]]);
      if (typeof taken === "string") await giveData(store, [{ slot: waitSlot(product.id), bytes: placeBytes(sid, product.id, email, taken) }]);
      return "error";
    }
  }

  const link = `${origin}/@${store.handle}/waitlist?token=${confirm}`;
  const g = givingWords(store.language);
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "transactional", asked: true },
    from: sender(store),
    to: email,
    subject: g.waitSubject(product.title).slice(0, 200),
    text: [
      g.waitAsked(store.name, product.title),
      "",
      g.waitOpen,
      link,
      "",
      g.waitWorks,
      consent ? g.waitConsented(store.name) : g.waitNotConsented(store.name),
      "",
      g.waitIgnore,
      g.waitLeave(`${origin}/@${store.handle}/waitlist?leave=${leave}`),
      "",
      g.sentBy(store.name),
    ].join("\n"),
  });
  return sent ? "sent" : "error";
}

/** What a link is for, without using it: for the page that shows its button. */
export async function readWaitToken(token: string): Promise<TokenGrant | null> {
  if (!WAIT_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", tokenKey(token)]]);
  return parseStoreWaitlistGrant(raw);
}

/**
 * Writes a confirmed waitlist entry back only while its confirmation link still exists and the entry still holds what
 * it was read with, in one step (#4268, #2576): KEYS[1] the link, KEYS[2] the waitlist; ARGV[1] the address, ARGV[2]
 * the entry, ARGV[3] the entry as it was read. Answers 1 written, 0 not. Billed as one EVAL and the calls inside it,
 * at most WAIT_CONFIRM_CALLS; lib/redis-memory.ts runs the same check in one step.
 */
const WAIT_CONFIRM = [
  "-- marktmorgen:waitlist-confirm:v2",
  'if redis.call("EXISTS", KEYS[1]) == 0 or redis.call("HGET", KEYS[2], ARGV[1]) ~= ARGV[3] then return 0 end',
  'redis.call("HSET", KEYS[2], ARGV[1], ARGV[2])',
  "return 1",
].join("\n");

/** The most redis.call one run of WAIT_CONFIRM makes: EXISTS, HGET and HSET (tests/waitlist-confirm-cost.test.ts). */
export const WAIT_CONFIRM_CALLS = 3;

/**
 * Public requests of the store's a press takes before it writes anything (#4404): the page the button is on pays one,
 * and a press that writes the entry back (WAIT_CONFIRM) or signs the address up to the list does more than that one
 * pays for (the link and the store read again, the script and its calls, the sign-up's first round), so it takes one
 * more first, or writes nothing. Held in tests/waitlist-confirm-cost.test.ts and named in tests/plan-cost-registry.ts.
 */
export const WAIT_CONFIRM_UNITS = 1;

/**
 * Presses the button in the email: the address now counts, and joins the creator's list if it asked to. `first` is
 * true when this press found the spot unconfirmed, false on any press after; read and then written in two trips, so
 * two presses at once can both see true: a filter only, never a count (lib/path-lead.ts decides once).
 */
export async function confirmSpot(token: string, store: Store | null): Promise<{ ok: true; productId: string; first: boolean } | { ok: false; reason?: "busy" }> {
  // Switched off after notices about its content: the spot does not count and joins no list (lib/store-join.ts listOpen).
  if (store?.suspended) return { ok: false };
  const grant = await readWaitToken(token);
  if (!grant || grant.k !== "confirm" || !store || store.statsId !== grant.s) return { ok: false };
  const readPlace = async () => {
    const [raw] = await redisPipeline([["HGET", listKey(grant.s, grant.p), grant.e]]);
    return { raw, read: parseEntry(raw) };
  };
  const first = await readPlace();
  if (!first.read) return { ok: false };
  // Paid before it spends: a press that writes takes WAIT_CONFIRM_UNITS of the store's public requests, or is refused.
  // A press whose first read is already confirmed writes nothing back, and one that is not pays here for both writes.
  const joins = Boolean(first.read.c && store.listId);
  // Refused for want of a request: the link still works, so the page says to press it again later, never "expired".
  if ((!first.read.ok || joins) && !(await takePublicRequest(store, "public", Date.now(), WAIT_CONFIRM_UNITS))) return { ok: false, reason: "busy" };
  // Both writes are fenced by this link (#4268): the person's erasure deletes it (its erasure note, joinWaitlist), so
  // a press read before an erasure that completes meanwhile neither writes the entry back nor puts the address on
  // the list again and lifts the erasure print. The entry is written only over the place as it was read (#2576), so a
  // place deleted or changed in between is not made again and two presses at once count its growth once.
  let entry: WaitEntry | null = null;
  for (let tries = 0; tries < 3 && !entry; tries += 1) {
    const { raw, read } = tries === 0 ? first : await readPlace();
    if (!read) return { ok: false };
    if (read.ok) {
      entry = read;
      break;
    }
    const next = JSON.stringify({ ...read, ok: now() });
    // Its growth counted before it is written (countEntryGrowth): a count not confirmed writes nothing, and the press
    // is said not done, so it is pressed again.
    const grown = await countEntryGrowth(store, grant.s, grant.p, grant.e, raw as string, next);
    if (grown === null) return { ok: false };
    const [written] = await redisPipeline([["EVAL", WAIT_CONFIRM, 2, tokenKey(token), listKey(grant.s, grant.p), grant.e, next, raw as string]]);
    // Written: a shrink goes back; an exact 0: what was counted goes back; anything else may have landed: it stays.
    await settleEntryWrite(store, grant.p, grown, written);
    if (written === 1) {
      entry = read;
      break;
    }
  }
  if (!entry) return { ok: false };
  if (entry.c && store.listId) {
    const added = await upsertContact(store.listId, grant.e, { agreed: true, explicit: true, clicks: entry.k === true, source: "free", at: new Date().toISOString(), sid: store.sid, fence: { key: tokenKey(token), seconds: CONFIRM_SECONDS } }, store, () => takePublicRequest(store, "public")).catch((error) => {
      console.error("could not add a waitlist address to a list", error);
      // An answer that is not known is not finished (CX-123 rule 24); a full list or room still confirms the spot.
      return error instanceof UnknownReplyError ? ({ gone: true } as const) : null;
    });
    if (added?.gone) return { ok: false };
  }
  return { ok: true, productId: grant.p, first: !entry.ok };
}

/** How long a deletion of a person may still be running after its first step: a sign-up that close to one is taken back (joinWaitlist). */
export const ERASURE_SECONDS = 15 * 60;

/** Where one product's waitlist is counted in the store's data room (lib/store-data.ts). */
const waitSlot = (productId: string) => `wl:${productId}`;

/** The longest handle a store may have (HANDLE_PATTERN, lib/store-handle-pattern.ts). */
export const LONGEST_HANDLE = 24;

/**
 * What a place's link to leave is counted at, the same when it is taken and
 * whenever it is given back: as if the store had the longest handle, so a
 * store renamed afterwards never has more given back than was taken.
 */
const leaveBytes = (sid: string, productId: string, email: string, token: string) =>
  dataBytes([tokenKey(token), JSON.stringify({ s: sid, h: "x".repeat(LONGEST_HANDLE), p: productId, e: email, k: "leave" } satisfies TokenGrant)], 1);

/**
 * What one place, as it is kept, gives back when it goes: itself and its link to leave. A place written before #2576
 * (no WaitEntry.w) stays counted and gives back nothing, as a community member without its room's origin does
 * (lib/community.ts): main counted it only at its join, with its link at the store's real handle, and its confirmation
 * and asking again rewrote it without counting what it grew by, so what it holds now was never what the slot holds for
 * it (Codex N1, and Claude 6's MEDIUM on #2576). The room only errs fuller.
 */
function placeBytes(sid: string, productId: string, email: string, raw: string): number {
  const entry = parseEntry(raw);
  // A place that does not read held no link counted, and was counted as it is (#4792), as before.
  if (!entry) return dataBytes([email, raw], 1);
  return entry.w ? dataBytes([email, raw], 1) + leaveBytes(sid, productId, email, entry.t) : 0;
}

/**
 * Every place of one product's waitlist, read and deleted in one step, for a
 * launch: the places' room goes back to `room`, but each link to leave is
 * still kept (the launch email carries it), so what it takes moves to a
 * record that comes off by itself once the link has expired.
 */
async function takeList(room: DataStore, sid: string, productId: string, at = Date.now()): Promise<boolean> {
  let places: [string, string][];
  try {
    const [taken] = await redisPipeline([["EVAL", HASH_TAKE_ALL, 1, listKey(sid, productId)]]);
    places = takenPairs(taken, "a launched waitlist's deletion");
  } catch (error) {
    // Unknown whether the list went: nothing is given back, the room erring fuller, and the launch stays on the
    // queue (JOBS), unfinished, so the next run deletes it again (Claude 1 on #2576): a list already gone answers
    // an empty take, which confirms it.
    console.error("launching a waitlist: its deletion was not confirmed, so it is tried again next run", error);
    return false;
  }
  const freed = places.reduce((sum, [email, raw]) => sum + placeBytes(sid, productId, email, raw), 0);
  const kept = places.reduce((sum, [email, raw]) => {
    const entry = parseEntry(raw);
    // An older place's link stays counted in the slot (placeBytes), so it is not counted again here.
    return sum + (entry?.w ? leaveBytes(sid, productId, email, entry.t) : 0);
  }, 0);
  if (freed > 0) await giveData(room, [{ slot: waitSlot(productId), bytes: freed }], at);
  if (kept > 0) await noteData(room, [{ until: at + WAIT_SECONDS * 1000, bytes: kept }], at);
  return true;
}

/**
 * What rewriting a place (confirmed, or asked again with the boxes checked) grows it by, counted BEFORE it is written,
 * never refused (Claude 6's MEDIUM on #2576, as lib/contacts.ts countOrderWrite): counted after, with noteData, a lost
 * count left the growth stored and never counted, and every later give-back returned it. null when the count is not
 * confirmed: nothing is written, the slot erring fuller if it landed after all. A store with no room key has nothing to
 * count.
 */
async function countEntryGrowth(store: DataStore, sid: string, productId: string, email: string, before: string, after: string): Promise<number | null> {
  const grown = placeBytes(sid, productId, email, after) - placeBytes(sid, productId, email, before);
  if (grown > 0 && dataKey(store) && !(await countData(store, [{ slot: waitSlot(productId), bytes: grown }])).ok) return null;
  return grown;
}

/**
 * After that write, by its exact answer: written (1), what a place shrank by goes back; not written (0), what was
 * counted for it goes back; any other answer may have landed, so what was counted stays and a shrink is never given
 * back.
 */
async function settleEntryWrite(store: DataStore, productId: string, grown: number, written: unknown): Promise<void> {
  const back = written === 1 ? -grown : written === 0 ? grown : 0;
  if (back > 0 && dataKey(store)) await giveData(store, [{ slot: waitSlot(productId), bytes: back }]);
}

/**
 * Takes an address off a waitlist. Its place is read and deleted in one step
 * and gives back to `room` (the store, when it is found) what it took, once.
 */
export async function leaveWaitlist(token: string, room?: DataStore | null): Promise<boolean> {
  const grant = await readWaitToken(token);
  if (!grant || grant.k !== "leave") return false;
  const [taken] = await redisPipeline([
    ["EVAL", HASH_TAKE_FIELD, 1, listKey(grant.s, grant.p), grant.e],
    ["DEL", tokenKey(token)],
  ]);
  if (room && typeof taken === "string") await giveData(room, [{ slot: waitSlot(grant.p), bytes: placeBytes(grant.s, grant.p, grant.e, taken) }]);
  return true;
}

// ------------------------------------------------------------------ the studio

/** `switchedOff`: the store is switched off after notices, so a launch still owed is paused (runLaunches). */
export type WaitlistView = { soon: boolean; confirmed: number; waiting: number; launch: LaunchJob | null; switchedOff: boolean };

export async function waitlistViews(store: Store, productIds: string[]): Promise<Record<string, WaitlistView>> {
  const out: Record<string, WaitlistView> = {};
  if (!store.statsId || !isRedisConfigured() || !productIds.length) return out;
  const sid = store.statsId;
  const soon = await soonProducts(store);
  const rows = await redisPipeline(productIds.flatMap((p) => [["HGETALL", listKey(sid, p)], ["GET", jobKey(sid, p)]]));
  productIds.forEach((p, i) => {
    const entries = entriesOf(rows[i * 2]);
    const launch = parseJob(rows[i * 2 + 1]);
    if (!soon.has(p) && !launch && entries.length === 0) return;
    out[p] = {
      soon: soon.has(p),
      confirmed: entries.filter(([, e]) => e.ok > 0).length,
      waiting: entries.filter(([, e]) => e.ok === 0).length,
      launch,
      switchedOff: Boolean(store.suspended),
    };
  });
  return out;
}

function entriesOf(raw: unknown): [string, WaitEntry][] {
  const pairs: [string, unknown][] = [];
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]), raw[i + 1]]);
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) pairs.push([k, v]);
  }
  return pairs.map(([k, v]) => [k, parseEntry(v)] as [string, WaitEntry | null]).filter((p): p is [string, WaitEntry] => p[1] !== null);
}

export type LaunchResult = { ok: true; total: number } | { ok: false; reason: "address" | "busy" | "switched_off" };

/**
 * Puts the product on sale and starts the one email to everyone who
 * confirmed. The five-minute job sends it (runLaunches). Refused, with
 * nothing written, while the store is switched off after notices.
 */
export async function launch(store: Store, product: Listing, input: { note: unknown; address: unknown }): Promise<LaunchResult> {
  if (store.suspended) return { ok: false, reason: "switched_off" };
  const address = cleanLine(input.address, MAX_LAUNCH_ADDRESS);
  const note = cleanText(input.note, MAX_LAUNCH_NOTE);
  if (!store.statsId) return { ok: false, reason: "busy" };
  const sid = store.statsId;
  const [rawJob, rawList] = exactReplies(
    await redisPipeline([
      ["GET", jobKey(sid, product.id)],
      ["HGETALL", listKey(sid, product.id)],
    ]),
    2,
    "a launch's job and waitlist",
  );
  // Unknown is never "no launch running" or "nobody waiting" (Claude 4's sweep, C4-2910, sweepA7 P4): read as
  // nobody, the list would be deleted with its room and nobody emailed; read as no launch, a second one could
  // start over one still sending. Either throws before anything is written.
  if (rawJob !== null && (typeof rawJob !== "string" || !parseJob(rawJob))) throw new UnknownReply("a launch's job");
  const pairs = plainList(rawList);
  if (!pairs || pairs.length % 2 !== 0 || pairs.some((value) => typeof value !== "string")) throw new UnknownReply("a launch's waitlist");
  // Every place must read as one: a value that is not a place ("{cut", "{}") is not "not waiting", or the launch would
  // delete a list it could not read whole (Codex G on #2576).
  for (let i = 1; i < pairs.length; i += 2) if (!parseEntry(pairs[i])) throw new UnknownReply("a launch's waitlist");
  const running = parseJob(rawJob);
  if (running && !running.finished) return { ok: false, reason: "busy" };
  const confirmed = entriesOf(pairs).filter(([, e]) => e.ok > 0).map(([email]) => email).sort();
  const total = confirmed.length;
  // A postal address is the law's for an email that offers something for sale (CAN-SPAM).
  if (total > 0 && !address) return { ok: false, reason: "address" };
  // The launch goes on the queue (JOBS) unfinished even with nobody to email, so a deletion of the list that is
  // not confirmed here is done by the next run (Claude 1 on #2576); it is finished here once it is.
  const job: LaunchJob = { handle: store.handle, note, address, total, cursor: 0, sent: 0, started: now(), finished: 0, stopped: 0 };
  await redisPipeline([
    ["SREM", soonKey(sid), product.id],
    ["SET", jobKey(sid, product.id), JSON.stringify(job), "EX", JOB_SECONDS],
    ["DEL", sendKey(sid, product.id)],
    ...(total ? [["RPUSH", sendKey(sid, product.id), ...confirmed], ["EXPIRE", sendKey(sid, product.id), JOB_SECONDS]] : []),
    ["SADD", JOBS, `${sid}|${product.id}`],
  ]);
  // Nobody to email: the waitlist goes now, and its room comes back.
  if (!total && (await takeList(store, sid, product.id))) {
    await redisPipeline([
      ["SET", jobKey(sid, product.id), JSON.stringify({ ...job, finished: now() }), "EX", 90 * 86_400],
      ["SREM", JOBS, `${sid}|${product.id}`],
    ]);
  }
  return { ok: true, total };
}

/**
 * The store and product a launch sends for, "gone" only on an exact answer
 * that one of them no longer exists, and "unknown" when a read did not come
 * back in its shape (rule 24). `load` and `readProduct` answer null for both,
 * so a null is checked again exactly: the handle's own key (Redis's nil, or a
 * name let go, is a free handle) and the product among the store's own ids,
 * then its listing record's size (STRLEN 0: no record).
 */
async function launchTarget(
  handle: string,
  sid: string,
  pid: string,
  load: (handle: string) => Promise<Store | null>,
  readProduct: (store: Store, id: string) => Promise<Listing | null>,
): Promise<{ store: Store; product: Listing } | "gone" | "unknown"> {
  let store: Store | null;
  try {
    store = await load(handle);
  } catch {
    return "unknown";
  }
  if (!store) {
    const reply = repliesFor(await redisPipeline([["GET", storeHandleKey(handle)]]), 1);
    if (!reply) return "unknown";
    const raw = reply[0];
    return raw === null || (typeof raw === "string" && !handleLeadsToStore(raw)) ? "gone" : "unknown";
  }
  // The handle now leads to another store: this launch's store is not there.
  if (store.statsId !== sid) return "gone";
  let product: Listing | null;
  try {
    product = await readProduct(store, pid);
  } catch {
    return "unknown";
  }
  if (product) return { store, product };
  if (!productIds(store).includes(pid)) return "gone";
  const sizes = await listingSizes(store, [pid]).catch(() => null);
  return sizes?.[0] === 0 ? "gone" : "unknown";
}

/**
 * Sends what launches still owe, a hundred at a time, until `deadline`.
 * Each batch carries a key made of where it starts, so a batch tried again
 * is never sent twice. Returns how many emails went.
 */
export async function runLaunches(load: (handle: string) => Promise<Store | null>, readProduct: (store: Store, id: string) => Promise<Listing | null>, deadline: number): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [members] = await redisPipeline([["SMEMBERS", JOBS]]);
  let sent = 0;
  for (const member of Array.isArray(members) ? (members as string[]) : []) {
    if (Date.now() > deadline) break;
    const [sid, pid] = member.split("|");
    // Only an exact answer that the launch is gone takes it off the queue
    // (rule 24). A read that came back in another shape holds it where it is:
    // nothing reserved, nothing sent, the cursor left, tried again next run.
    // A hold is bounded: the job key lapses 120 days after its last write, and
    // then its exact nil finishes the launch here.
    const jobReply = repliesFor(await redisPipeline([["GET", jobKey(sid, pid)]]), 1);
    const job = jobReply && typeof jobReply[0] === "string" ? parseJob(jobReply[0]) : null;
    if (!job) {
      if (jobReply && jobReply[0] === null) await redisPipeline([["SREM", JOBS, member]]);
      else console.error("sending a waitlist launch: its job was read in an unknown shape, so it waits", new UnknownReplyError("a waitlist launch's job"));
      continue;
    }
    if (job.finished) {
      await redisPipeline([["SREM", JOBS, member]]);
      continue;
    }
    const target = await launchTarget(job.handle, sid, pid, load, readProduct);
    if (target === "gone") {
      await redisPipeline([["SREM", JOBS, member]]);
      continue;
    }
    if (target === "unknown") {
      console.error("sending a waitlist launch: its store or product was read in an unknown shape, so it waits", new UnknownReplyError("a waitlist launch's store or product"));
      continue;
    }
    const { store, product } = target;
    // Switched off after notices about its content (lib/takedown.ts): the
    // launch waits where it is, nothing reserved or sent, and goes on once
    // the store is back on. Each held run keeps its record and send list
    // alive; held LAUNCH_HOLD_SECONDS from its start, it stops (holdLaunch).
    // One already handled in full only has its finish written below.
    if (store.suspended && job.cursor < job.total) {
      await holdLaunch(store, sid, pid, member, job);
      continue;
    }
    const said = speech(store);
    const g = givingWords(store.language);
    const words = launchBody(
      {
        storeName: store.name,
        title: product.title,
        price: product.priceCents > 0 ? said.money(product.priceCents) : "",
        link: `${SITE_URL}/@${store.handle}/p/${productSegment(product)}`,
        note: job.note,
      },
      store.language,
    );
    const sender = { ...store, mail: { fromName: store.mail?.fromName || store.name, address: job.address } };
    let batches = 0;
    while (job.cursor < job.total && Date.now() <= deadline) {
      // Read again before every batch after the first, so a switch-off during
      // the run stops the rest (one store read a batch). Anything but this
      // store, read and on, waits for the next run, which reads it in full.
      if (batches++ > 0) {
        const again = await load(job.handle).catch(() => null);
        if (!again || again.statsId !== sid || again.suspended) break;
      }
      const [slice] = await redisPipeline([["LRANGE", sendKey(sid, pid), job.cursor, job.cursor + LAUNCH_BATCH - 1]]);
      const emails = Array.isArray(slice) ? (slice as string[]) : [];
      if (!emails.length) break;
      const [rows] = await redisPipeline([["HMGET", listKey(sid, pid), ...emails]]);
      // Whoever removed their address since the launch started (an exact
      // null) is skipped. A reply of another shape, or a place that does not
      // read as one, is unknown, never "left" (rule 24): the batch waits for
      // the next run, as on a retry, rather than passing them over for good.
      const places = repliesFor(rows, emails.length);
      const chunk: (readonly [string, WaitEntry])[] = [];
      let unknown = places === null;
      if (places) {
        for (const [i, email] of emails.entries()) {
          const place = places[i];
          if (place === null) continue;
          const entry = typeof place === "string" ? parseEntry(place) : null;
          if (!entry) {
            unknown = true;
            break;
          }
          chunk.push([email, entry]);
        }
      }
      if (unknown) {
        console.error("sending a waitlist launch: its places were read in an unknown shape, so the batch waits", new UnknownReplyError("a launch batch's waitlist places"));
        break;
      }
      const day = mailDay();
      if (!(await reserveDay(chunk.length, day))) break;
      const messages = chunk.map(([email, entry]) => {
        const page = `${SITE_URL}/@${store.handle}/waitlist?leave=${entry.t}`;
        const door = {
          page,
          oneClick: `${SITE_URL}/api/store/waitlist/leave?t=${entry.t}`,
          why: g.launchWhy(product.title),
          label: g.launchLabel,
          after: g.launchAfter,
          line: g.launchLine(page),
          sent: g.sentWith,
          lang: said.lang.locale,
        };
        const r = render(sender, words.subject, words.body, null, door);
        return { from: fromLine(sender), to: email, subject: r.subject, text: r.text, html: r.html, replyTo: store.email, headers: r.headers };
      });
      const outcome = await sendBatch(messages, `waitlist:${sid}:${pid}:${job.started}:${job.cursor}`, { by: "store", store, kind: "email" });
      if (outcome === "retry") {
        await releaseDay(chunk.length, day);
        break;
      }
      if (outcome === "refused") await releaseDay(chunk.length, day);
      else {
        job.sent += chunk.length;
        sent += chunk.length;
      }
      job.cursor += emails.length;
      // The send list is renewed with the record, so it never lapses while the record lives.
      await redisPipeline([
        ["SET", jobKey(sid, pid), JSON.stringify(job), "EX", JOB_SECONDS],
        ["EXPIRE", sendKey(sid, pid), JOB_SECONDS],
      ]);
    }
    if (job.cursor >= job.total) {
      // The waitlist has done its one job: its addresses go. Whoever asked to
      // hear more is on the creator's list already (confirmSpot). The launch
      // is finished and leaves the queue only once that deletion is confirmed:
      // one that failed or answered in another shape is tried again next run,
      // with nothing sent again (the cursor is at the end) (Claude 1 on #2576).
      if (!(await takeList(store, sid, pid))) continue;
      job.finished = now();
      await redisPipeline([
        ["SET", jobKey(sid, pid), JSON.stringify(job), "EX", 90 * 86_400],
        ["DEL", sendKey(sid, pid)],
        ["SREM", JOBS, member],
      ]);
    }
  }
  return sent;
}

/**
 * A launch owed while its store is switched off. Before LAUNCH_HOLD_SECONDS
 * from its start, one EXPIRE pair renews its send list and its record, so it
 * still goes out once the store is back on; a reply not in its shape is logged
 * and the launch held as it is, tried again next run (rule 24), except in the
 * hold's last week (HOLD_LAST_STRETCH), where it stops at once: every write of
 * the record is at or after its start and keeps it JOB_SECONDS, so it still
 * lives then, and the stop is seen instead of a silent lapse. Past it, or
 * once its send list is confirmed gone (EXPIRE 0), the launch stops: its record
 * says so (`stopped`), kept as a finished launch is, the addresses already
 * handled leave the waitlist, and whoever was not emailed stays on it, so the
 * creator can start the launch again. The handled addresses are read exactly
 * (LRANGE of the cursor's length); another shape holds it for the next run.
 */
async function holdLaunch(room: DataStore, sid: string, pid: string, member: string, job: LaunchJob): Promise<void> {
  if (now() - job.started < LAUNCH_HOLD_SECONDS) {
    const renewed = repliesFor(
      await redisPipeline([
        ["EXPIRE", sendKey(sid, pid), JOB_SECONDS],
        ["EXPIRE", jobKey(sid, pid), JOB_SECONDS],
      ]),
      2,
    );
    if (!renewed || !renewed.every((r) => r === 0 || r === 1)) {
      if (now() - job.started < LAUNCH_HOLD_SECONDS - HOLD_LAST_STRETCH) {
        console.error("holding a waitlist launch: its keys were renewed in an unknown shape, so it waits", new UnknownReplyError("a held launch's renewal"));
        return;
      }
      console.error("holding a waitlist launch: its keys were renewed in an unknown shape in the hold's last week, so it stops now", new UnknownReplyError("a held launch's renewal"));
    } else if (renewed[1] === 0 || renewed[0] === 1) {
      // The record lapsed between the reads: the next run's exact nil ends it.
      // The send list still there, or none owed: held as it is.
      return;
    }
  }
  const handled = job.cursor > 0 ? stringList(repliesFor(await redisPipeline([["LRANGE", sendKey(sid, pid), 0, job.cursor - 1]]), 1)?.[0]) : [];
  // An exact list of the cursor's length, or an exact empty one when the list is gone; anything else waits.
  if (!handled || (handled.length !== job.cursor && handled.length !== 0)) {
    console.error("stopping a waitlist launch: who it emailed was read in an unknown shape, so it waits", new UnknownReplyError("a stopped launch's handled addresses"));
    return;
  }
  const at = now();
  // Each handled address's place is read and taken in one step (merge of main into #2576): what it took comes back to
  // the store's room once, and its link to leave, which the launch email carried, stays counted until it lapses, as
  // takeList does. A reply that does not read gives nothing back, the room erring fuller.
  const replies = await redisPipeline([
    ["SET", jobKey(sid, pid), JSON.stringify({ ...job, finished: at, stopped: at }), "EX", 90 * 86_400],
    ...handled.map((email) => ["EVAL", HASH_TAKE_FIELD, 1, listKey(sid, pid), email]),
    ["DEL", sendKey(sid, pid)],
    ["SREM", JOBS, member],
  ]);
  const taken = Array.isArray(replies) && replies.length === handled.length + 3 ? replies.slice(1, 1 + handled.length) : [];
  const places = handled.flatMap((email, i) => (typeof taken[i] === "string" ? [[email, taken[i] as string] as const] : []));
  const freed = places.reduce((sum, [email, raw]) => sum + placeBytes(sid, pid, email, raw), 0);
  const kept = places.reduce((sum, [email, raw]) => {
    const entry = parseEntry(raw);
    // An older place's link stays counted in the slot (placeBytes), so it is not counted again here.
    return sum + (entry?.w ? leaveBytes(sid, pid, email, entry.t) : 0);
  }, 0);
  if (freed > 0) await giveData(room, [{ slot: waitSlot(pid), bytes: freed }], at * 1000);
  if (kept > 0) await noteData(room, [{ until: at * 1000 + WAIT_SECONDS * 1000, bytes: kept }], at * 1000);
}

/**
 * Takes one address off every waitlist of the store, out of any launch email
 * still going out, and deletes its confirm and leave links (lib/person-erasure.ts).
 * Each place is read and deleted in one step, and what joining took for it
 * (the place as it now is, and its link to leave) goes back to `room`, when
 * it is given, once.
 */
export async function forgetWaitlistPerson(sid: string | null, productIds: string[], email: string, room?: DataStore): Promise<number> {
  if (!sid || !isRedisConfigured()) return 0;
  const address = normaliseEmail(email);
  const what = "the deletion of a person's waitlist places";
  // One reply per product, each the place or a confirmed none (null); a pipeline that answered another number of
  // replies, or a reply of another shape, is unknown (rule 24, #4383): UnknownReplyError, so the erasure is never
  // reported complete while a place holding the address may still be there to be copied into a launch.
  const answered = productIds.length ? await redisPipeline(productIds.map((p) => ["EVAL", HASH_TAKE_FIELD, 1, listKey(sid, p), address])) : [];
  let replies: unknown[];
  try {
    replies = productIds.length ? exactReplies(answered, productIds.length, what) : [];
  } catch {
    throw new UnknownReplyError(what);
  }
  const freed = productIds.flatMap((p, i) => {
    const raw = replies[i];
    return typeof raw === "string" ? [{ slot: waitSlot(p), bytes: placeBytes(sid, p, address, raw) }] : [];
  });
  // What was confirmed taken comes back; a place whose reply is unknown keeps its room.
  if (room && freed.length) await giveData(room, freed);
  const blanked = await blankInLists(productIds.map((p) => sendKey(sid, p)), address);
  if (replies.some((raw) => raw !== null && typeof raw !== "string")) throw new UnknownReplyError(what);
  return freed.length + blanked;
}

/**
 * A person's places on the store's waitlists, for the copy of their data
 * (619 [SZ3], lib/person-copy.ts): when they joined, when they confirmed,
 * and whether they also asked to hear from the creator. The secret in their
 * waitlist link is left out. Only reads.
 */
export async function waitlistPlacesOf(sid: string | null, productIds: string[], email: string): Promise<{ product: string; joined: number; confirmed: number; news: boolean }[]> {
  if (!sid || !productIds.length || !isRedisConfigured()) return [];
  const address = normaliseEmail(email);
  // One reply per product, each the place or an exact null (none). Anything
  // else is unknown, never "on no waitlist" (rule 24): the copy says it could
  // not be made (lib/person-copy.ts).
  const what = "a person's waitlist places";
  const replies = repliesFor(await redisPipeline(productIds.map((p) => ["HGET", listKey(sid, p), address])), productIds.length);
  if (!replies) throw new UnknownReplyError(what);
  return productIds.flatMap((product, i) => {
    if (replies[i] === null) return [];
    const entry = typeof replies[i] === "string" ? parseEntry(replies[i]) : null;
    if (!entry) throw new UnknownReplyError(what);
    return [{ product, joined: entry.at, confirmed: entry.ok, news: entry.c }];
  });
}
