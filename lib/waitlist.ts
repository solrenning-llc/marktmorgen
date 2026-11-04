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
import { withinStore } from "@/lib/metered-limits";
import { createHash } from "node:crypto";
import { WAIT_TOKEN, newWaitlistToken as newToken, waitlistTokenKey as tokenKey, parseStoreWaitlistGrant, type StoreWaitlistGrant as TokenGrant } from "@/lib/waitlist-tokens";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, noteData, takeData } from "@/lib/store-data";
import { HASH_SWAP_IF, HASH_TAKE_ALL, HASH_TAKE_FIELD, takenPairs } from "@/lib/redis-take";
import { dataBytes } from "@/lib/store-data-rules";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, sendBatch, sendEmail } from "@/lib/email";
import { withinLimit } from "@/lib/request-guard";
import { fromLine, releaseDay, render, reserveDay } from "@/lib/mail";
import { upsertContact } from "@/lib/contacts";
import { SITE_URL } from "@/lib/site-url";
import type { Listing, Store } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import {
  CONFIRM_SECONDS,
  LAUNCH_BATCH,
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

const soonKey = (sid: string) => `nl:wl:${sid}:soon`;
const listKey = (sid: string, pid: string) => `nl:wl:${sid}:${pid}`;
const jobKey = (sid: string, pid: string) => `nl:wl:${sid}:${pid}:job`;
const sendKey = (sid: string, pid: string) => `nl:wl:${sid}:${pid}:send`;
const JOBS = "nl:wl:jobs";
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

/** The products of a store that are coming soon, for its pages. */
export async function soonProducts(store: Store): Promise<Set<string>> {
  if (!store.statsId || !isRedisConfigured()) return new Set();
  const [raw] = await redisPipeline([["SMEMBERS", soonKey(store.statsId)]]);
  return new Set(Array.isArray(raw) ? (raw as string[]) : []);
}

export async function isSoon(store: Store, productId: string): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const [raw] = await redisPipeline([["SISMEMBER", soonKey(store.statsId), productId]]);
  return raw === 1 || raw === "1";
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
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!store.statsId || !isRedisConfigured()) return "error";
  if (!(await isSoon(store, product.id))) return "closed";
  const email = normaliseEmail(raw);
  const sid = store.statsId;
  if (!(await withinStore("waitlist-ip", `${sid}:${ip}`, 10, 3_600, store))) return "limited";
  if (!(await withinLimit("waitlist-address", sha(email), 5, 3_600))) return "limited";

  const confirm = newToken();
  const grant = (k: TokenGrant["k"], t: string): (string | number)[] => ["SET", tokenKey(t), JSON.stringify({ s: sid, h: store.handle, p: product.id, e: email, k } satisfies TokenGrant), "EX", k === "confirm" ? CONFIRM_SECONDS : WAIT_SECONDS];
  // The links go before the place, noted for a deletion of the person: one
  // that runs in between deletes them too, and never leaves a link with the
  // address on it or a link to leave nobody counted.
  const links = (leave: string) =>
    redisPipeline([grant("confirm", confirm), grant("leave", leave), ...noteForErasure(sid, email, tokenKey(confirm)), ...noteForErasure(sid, email, tokenKey(leave))]);

  // A place written by another request between the read and the write (a
  // double click) is read again and asked again; one deleted in between is
  // not made again.
  let leave = "";
  let mustExist = false;
  let lastLink = "";
  for (let tries = 0; tries < 3 && !leave; tries += 1) {
    const [existing, size] = await redisPipeline([
      ["HGET", listKey(sid, product.id), email],
      ["HLEN", listKey(sid, product.id)],
    ]);
    if (typeof existing !== "string") {
      if (mustExist) {
        // Deleted in between: the links this request wrote go with it.
        await redisPipeline([["DEL", tokenKey(confirm), ...(lastLink ? [tokenKey(lastLink)] : [])]]);
        return "error";
      }
      if (Number(size) >= MAX_WAITLIST) return "full";
      const t = newToken();
      const value = JSON.stringify({ at: now(), ok: 0, c: consent, ...(consent && input.clicks ? { k: true } : {}), t } satisfies WaitEntry);
      // A new address takes room in the store's data room, with its link to leave
      // (kept as long as the list); with no room the list is full for it.
      const taken = placeBytes(sid, product.id, email, value);
      if (!(await takeData(store, [{ slot: waitSlot(product.id), bytes: taken }])).ok) return "full";
      await links(t);
      const [added] = await redisPipeline([["HSETNX", listKey(sid, product.id), email, value]]);
      if (Number(added) === 1) {
        leave = t;
        break;
      }
      // Another request wrote it first: this one's room and its unused link to leave go, and it asks again.
      await giveData(store, [{ slot: waitSlot(product.id), bytes: taken }]);
      await redisPipeline([["DEL", tokenKey(t)]]);
      mustExist = true;
      continue;
    }
    // Asked again: written only over the place as it was read, counted at what
    // it changed. A place that cannot be read is replaced by a new one.
    const before = parseEntry(existing);
    const t = before?.t ?? newToken();
    const asked = Boolean(before?.c) || consent;
    const value = JSON.stringify({ at: before?.at ?? now(), ok: before?.ok ?? 0, c: asked, ...(asked && (before?.k || (consent && input.clicks)) ? { k: true } : {}), t } satisfies WaitEntry);
    await links(t);
    lastLink = t;
    const [swapped] = await redisPipeline([["EVAL", HASH_SWAP_IF, 1, listKey(sid, product.id), email, existing, value]]);
    if (Number(swapped) === 1) {
      await settleEntry(store, sid, product.id, email, existing, value);
      leave = t;
      break;
    }
    if (!before) await redisPipeline([["DEL", tokenKey(t)]]);
    mustExist = true;
  }
  if (!leave) return "error";

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

/** Presses the button in the email: the address now counts, and joins the creator's list if it asked to. */
export async function confirmSpot(token: string, store: Store | null): Promise<{ ok: true; productId: string } | { ok: false }> {
  const grant = await readWaitToken(token);
  if (!grant || grant.k !== "confirm" || !store || store.statsId !== grant.s) return { ok: false };
  // Written only over the place as it was read, so a place deleted in between
  // is not made again and two presses at once count its growth once.
  let entry: WaitEntry | null = null;
  for (let tries = 0; tries < 3 && !entry; tries += 1) {
    const [raw] = await redisPipeline([["HGET", listKey(grant.s, grant.p), grant.e]]);
    const read = parseEntry(raw);
    if (!read) return { ok: false };
    if (read.ok) {
      entry = read;
      break;
    }
    const next = JSON.stringify({ ...read, ok: now() });
    const [swapped] = await redisPipeline([["EVAL", HASH_SWAP_IF, 1, listKey(grant.s, grant.p), grant.e, raw as string, next]]);
    if (Number(swapped) !== 1) continue;
    await settleEntry(store, grant.s, grant.p, grant.e, raw as string, next);
    entry = read;
  }
  if (!entry) return { ok: false };
  if (entry.c && store.listId) {
    await upsertContact(store.listId, grant.e, { agreed: true, explicit: true, clicks: entry.k === true, source: "free", at: new Date().toISOString(), sid: store.sid }, store).catch((error) =>
      console.error("could not add a waitlist address to a list", error),
    );
  }
  return { ok: true, productId: grant.p };
}

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

/** What one place, as it is kept, gives back when it goes: itself and its link to leave. */
function placeBytes(sid: string, productId: string, email: string, raw: string): number {
  const entry = parseEntry(raw);
  return dataBytes([email, raw], 1) + (entry ? leaveBytes(sid, productId, email, entry.t) : 0);
}

/**
 * Every place of one product's waitlist, read and deleted in one step, for a
 * launch: the places' room goes back to `room`, but each link to leave is
 * still kept (the launch email carries it), so what it takes moves to a
 * record that comes off by itself once the link has expired.
 */
async function takeList(room: DataStore, sid: string, productId: string, at = Date.now()): Promise<void> {
  const [taken] = await redisPipeline([["EVAL", HASH_TAKE_ALL, 1, listKey(sid, productId)]]);
  const places = takenPairs(taken);
  const freed = places.reduce((sum, [email, raw]) => sum + placeBytes(sid, productId, email, raw), 0);
  const kept = places.reduce((sum, [email, raw]) => {
    const entry = parseEntry(raw);
    return sum + (entry ? leaveBytes(sid, productId, email, entry.t) : 0);
  }, 0);
  if (freed > 0) await giveData(room, [{ slot: waitSlot(productId), bytes: freed }], at);
  if (kept > 0) await noteData(room, [{ until: at + WAIT_SECONDS * 1000, bytes: kept }], at);
}

/**
 * Counts what rewriting a place changed (confirmed, or asked again with the
 * boxes checked), as it is and never refused, so the room always holds what
 * each place weighs and a deletion gives back exactly that.
 */
async function settleEntry(store: DataStore, sid: string, productId: string, email: string, before: string, after: string): Promise<void> {
  // Its link to leave too: a place that could not be read held none counted.
  const grown = placeBytes(sid, productId, email, after) - placeBytes(sid, productId, email, before);
  if (grown > 0) await noteData(store, [{ slot: waitSlot(productId), bytes: grown }]);
  else if (grown < 0) await giveData(store, [{ slot: waitSlot(productId), bytes: -grown }]);
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

export type WaitlistView = { soon: boolean; confirmed: number; waiting: number; launch: LaunchJob | null };

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

export type LaunchResult = { ok: true; total: number } | { ok: false; reason: "address" | "busy" };

/**
 * Puts the product on sale and starts the one email to everyone who
 * confirmed. The five-minute job sends it (runLaunches).
 */
export async function launch(store: Store, product: Listing, input: { note: unknown; address: unknown }): Promise<LaunchResult> {
  const address = cleanLine(input.address, MAX_LAUNCH_ADDRESS);
  const note = cleanText(input.note, MAX_LAUNCH_NOTE);
  if (!store.statsId) return { ok: false, reason: "busy" };
  const sid = store.statsId;
  const [rawJob, rawList] = await redisPipeline([
    ["GET", jobKey(sid, product.id)],
    ["HGETALL", listKey(sid, product.id)],
  ]);
  const running = parseJob(rawJob);
  if (running && !running.finished) return { ok: false, reason: "busy" };
  const confirmed = entriesOf(rawList).filter(([, e]) => e.ok > 0).map(([email]) => email).sort();
  const total = confirmed.length;
  // A postal address is the law's for an email that offers something for sale (CAN-SPAM).
  if (total > 0 && !address) return { ok: false, reason: "address" };
  const job: LaunchJob = { handle: store.handle, note, address, total, cursor: 0, sent: 0, started: now(), finished: total ? 0 : now() };
  await redisPipeline([
    ["SREM", soonKey(sid), product.id],
    ["SET", jobKey(sid, product.id), JSON.stringify(job), "EX", 120 * 86_400],
    ["DEL", sendKey(sid, product.id)],
    ...(total ? [["RPUSH", sendKey(sid, product.id), ...confirmed], ["EXPIRE", sendKey(sid, product.id), 30 * 86_400], ["SADD", JOBS, `${sid}|${product.id}`]] : []),
  ]);
  // Nobody to email: the waitlist goes now, and its room comes back.
  if (!total) await takeList(store, sid, product.id);
  return { ok: true, total };
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
    const [rawJob] = await redisPipeline([["GET", jobKey(sid, pid)]]);
    const job = parseJob(rawJob);
    const store = job ? await load(job.handle) : null;
    const product = store && store.statsId === sid ? await readProduct(store, pid) : null;
    if (!job || job.finished || !store || !product) {
      await redisPipeline([["SREM", JOBS, member]]);
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
    while (job.cursor < job.total && Date.now() <= deadline) {
      const [slice] = await redisPipeline([["LRANGE", sendKey(sid, pid), job.cursor, job.cursor + LAUNCH_BATCH - 1]]);
      const emails = Array.isArray(slice) ? (slice as string[]) : [];
      if (!emails.length) break;
      const [rows] = await redisPipeline([["HMGET", listKey(sid, pid), ...emails]]);
      // Whoever removed their address since the launch started is skipped.
      const chunk = emails
        .map((email, i) => [email, parseEntry(Array.isArray(rows) ? rows[i] : null)] as const)
        .filter((pair): pair is readonly [string, WaitEntry] => pair[1] !== null);
      if (!(await reserveDay(chunk.length))) break;
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
        await releaseDay(chunk.length);
        break;
      }
      if (outcome === "refused") await releaseDay(chunk.length);
      else {
        job.sent += chunk.length;
        sent += chunk.length;
      }
      job.cursor += emails.length;
      await redisPipeline([["SET", jobKey(sid, pid), JSON.stringify(job), "EX", 120 * 86_400]]);
    }
    if (job.cursor >= job.total) {
      job.finished = now();
      // The waitlist has done its one job: its addresses go. Whoever asked to
      // hear more is on the creator's list already (confirmSpot).
      await redisPipeline([
        ["SET", jobKey(sid, pid), JSON.stringify(job), "EX", 90 * 86_400],
        ["DEL", sendKey(sid, pid)],
        ["SREM", JOBS, member],
      ]);
      await takeList(store, sid, pid);
    }
  }
  return sent;
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
  const replies = productIds.length ? await redisPipeline(productIds.map((p) => ["EVAL", HASH_TAKE_FIELD, 1, listKey(sid, p), address])) : [];
  const freed = productIds.flatMap((p, i) => {
    const raw = replies[i];
    return typeof raw === "string" ? [{ slot: waitSlot(p), bytes: placeBytes(sid, p, address, raw) }] : [];
  });
  if (room && freed.length) await giveData(room, freed);
  const blanked = await blankInLists(productIds.map((p) => sendKey(sid, p)), address);
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
  const replies = await redisPipeline(productIds.map((p) => ["HGET", listKey(sid, p), address]));
  return productIds.flatMap((product, i) => {
    const entry = parseEntry(replies[i]);
    return entry ? [{ product, joined: entry.at, confirmed: entry.ok, news: entry.c }] : [];
  });
}
