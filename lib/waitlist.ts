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
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { withinStore } from "@/lib/metered-limits";
import { createHash } from "node:crypto";
import { WAIT_TOKEN, newWaitlistToken as newToken, waitlistTokenKey as tokenKey, parseStoreWaitlistGrant, type StoreWaitlistGrant as TokenGrant } from "@/lib/waitlist-tokens";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, sendBatch, sendEmail } from "@/lib/email";
import { essentialLimitState } from "@/lib/request-guard";
import { fromLine, releaseDay, render, reserveDay } from "@/lib/mail";
import { upsertContact } from "@/lib/contacts";
import { SITE_URL } from "@/lib/site-url";
import { handleLeadsToStore, storeHandleKey, type Listing, type Store } from "@/lib/store";
import { listingSizes, productIds } from "@/lib/catalog";
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
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!store.statsId || !isRedisConfigured()) return "error";
  if (!(await isSoon(store, product.id))) return "closed";
  const email = normaliseEmail(raw);
  const sid = store.statsId;
  if (!(await withinStore("waitlist-ip", `${sid}:${ip}`, 10, 3_600, store))) return "limited";
  const allowance = await essentialLimitState("waitlist-address", sha(email), 5, 3_600);
  if (allowance !== "within") return allowance === "exceeded" ? "limited" : "error";

  const [existing, size] = await redisPipeline([
    ["HGET", listKey(sid, product.id), email],
    ["HLEN", listKey(sid, product.id)],
  ]);
  const before = parseEntry(existing);
  if (!before && Number(size) >= MAX_WAITLIST) return "full";

  const leave = before?.t ?? newToken();
  const asked = Boolean(before?.c) || consent;
  const entry: WaitEntry = { at: before?.at ?? now(), ok: before?.ok ?? 0, c: asked, ...(asked && (before?.k || (consent && input.clicks)) ? { k: true } : {}), t: leave };
  const confirm = newToken();
  const grant = (k: TokenGrant["k"]): string => JSON.stringify({ s: sid, h: store.handle, p: product.id, e: email, k } satisfies TokenGrant);
  // A new address takes room in the store's data room, with its link to leave
  // (kept as long as the list); with no room the list is full for it.
  if (!before && !(await takeData(store, [{ slot: `wl:${product.id}`, bytes: dataBytes([email, JSON.stringify(entry)], 1) + dataBytes([tokenKey(leave), grant("leave")], 1) }])).ok) return "full";
  await redisPipeline([
    ["HSET", listKey(sid, product.id), email, JSON.stringify(entry)],
    ["SET", tokenKey(confirm), grant("confirm"), "EX", CONFIRM_SECONDS],
    ["SET", tokenKey(leave), grant("leave"), "EX", WAIT_SECONDS],
    ...noteForErasure(sid, email, tokenKey(confirm)),
    ...noteForErasure(sid, email, tokenKey(leave)),
  ]);

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
  const [raw] = await redisPipeline([["HGET", listKey(grant.s, grant.p), grant.e]]);
  const entry = parseEntry(raw);
  if (!entry) return { ok: false };
  if (!entry.ok) {
    await redisPipeline([["HSET", listKey(grant.s, grant.p), grant.e, JSON.stringify({ ...entry, ok: now() })]]);
  }
  if (entry.c && store.listId) {
    await upsertContact(store.listId, grant.e, { agreed: true, explicit: true, clicks: entry.k === true, source: "free", at: new Date().toISOString(), sid: store.sid }, store).catch((error) =>
      console.error("could not add a waitlist address to a list", error),
    );
  }
  return { ok: true, productId: grant.p };
}

/** Takes an address off a waitlist. */
export async function leaveWaitlist(token: string): Promise<boolean> {
  const grant = await readWaitToken(token);
  if (!grant || grant.k !== "leave") return false;
  await redisPipeline([
    ["HDEL", listKey(grant.s, grant.p), grant.e],
    ["DEL", tokenKey(token)],
  ]);
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
    ...(total
      ? [["RPUSH", sendKey(sid, product.id), ...confirmed], ["EXPIRE", sendKey(sid, product.id), 30 * 86_400], ["SADD", JOBS, `${sid}|${product.id}`]]
      : [["DEL", listKey(sid, product.id)]]),
  ]);
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
        ["DEL", listKey(sid, pid)],
        ["DEL", sendKey(sid, pid)],
        ["SREM", JOBS, member],
      ]);
    }
  }
  return sent;
}

/**
 * Takes one address off every waitlist of the store, out of any launch email
 * still going out, and deletes its confirm and leave links (lib/person-erasure.ts).
 */
export async function forgetWaitlistPerson(sid: string | null, productIds: string[], email: string): Promise<number> {
  if (!sid || !isRedisConfigured()) return 0;
  const address = normaliseEmail(email);
  const replies = productIds.length ? await redisPipeline(productIds.map((p) => ["HDEL", listKey(sid, p), address])) : [];
  const blanked = await blankInLists(productIds.map((p) => sendKey(sid, p)), address);
  return replies.reduce<number>((sum, n) => sum + (Number(n) || 0), 0) + blanked;
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
