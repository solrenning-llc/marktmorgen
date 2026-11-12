/**
 * Outreach, on the server (lib/outreach-rules.ts has the rules and why):
 * reading a business's own website for the address it published, keeping
 * each pitch with the proof of where its address was found, and holding
 * every one to the rules before a word of it is written.
 *
 * What is read of somebody else's site is as little as answers the question:
 * its robots.txt, its front page, and at most three pages its own menu calls
 * contact, partners, press or about — each once, by a reader that says who it
 * is, through the same guarded fetch as every address a creator types
 * (lib/safe-fetch.ts). Nothing is read that robots.txt asks readers to leave
 * alone, nothing behind a login, and nothing is kept but the addresses at
 * the business's own domain with the words around them.
 *
 * What is never done here: sending. A pitch is a draft the creator opens in
 * their own mailbox.
 *
 *   nl:outreach:<statsId>:pitches       each pitch, by id (a hash)
 *   nl:outreach:<statsId>:stop          the domains that asked this store to stop (a set)
 *   nl:outreach:<statsId>:me            who is writing: the name and postal address on every pitch
 *   nl:outreach:<statsId>:day:<date>    pitches written that day
 *   nl:outreach:stoplink:<key>          the pitch a stop link in a footer belongs to
 *   nl:outreach:stop:all                the domains that asked that no store here write to them (a set)
 */
import { giveData, takeData } from "@/lib/store-data";
import { randomBytes } from "node:crypto";
import { writePitch } from "@/lib/ai";
import { readTitles } from "@/lib/catalog";
import {
  type CountryRule,
  type FoundAddress,
  MAX_PAGES_READ,
  MAX_PITCH_BODY,
  MAX_PITCH_SUBJECT,
  MAX_PITCHES,
  type OutreachGoal,
  PITCH_STATUSES,
  READER_NAME,
  STOP_LINK,
  type Pitch,
  type PitchProblem,
  type PitchStatus,
  type Sender,
  cleanSender,
  contactPages,
  countryRule,
  isOwnAddress,
  pageText,
  parsePitch,
  pitchFooter,
  pitchProblem,
  publishedAddresses,
  refusesProposals,
  robotsAllows,
  robotsDisallows,
  siteDomain,
} from "@/lib/outreach-rules";
import { storeBase } from "@/lib/purchase-email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { textCountOf } from "@/lib/redis-count";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { SafeFetchError, checkUrl, safeFetch } from "@/lib/safe-fetch";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";

/** Who is reading, said to every site read. */
export const READER = `${READER_NAME}/1.0 (+${SITE_URL}/help#outreach)`;
// A shop's front page is often most of a megabyte of markup; one that is cut short reads as no page at all.
const PAGE_BYTES = 3_000_000;
const PAGE_MS = 8_000;

/** One page of somebody's site, or null when it could not or should not be read. For tests to stand in for. */
export type PageReader = (url: string) => Promise<{ url: string; html: string } | null>;

const readPage: PageReader = async (url) => {
  try {
    const answer = await safeFetch(url, { maxBytes: PAGE_BYTES, timeoutMs: PAGE_MS, maxRedirects: 3, headers: { "User-Agent": READER, Accept: "text/html,text/plain;q=0.8" } });
    if (answer.status !== 200) return null;
    const type = (answer.headers["content-type"] ?? "").toLowerCase();
    if (type && !/text\/|html|xml/.test(type)) return null;
    return { url: answer.url, html: answer.body.toString("utf8") };
  } catch (error) {
    if (!(error instanceof SafeFetchError)) console.error("reading a site for its contact failed", error);
    return null;
  }
};

export type SiteProblem = "address" | "unreadable";

export type SiteRead = {
  /** The business's own domain, as its addresses carry it. */
  domain: string;
  /** Its front page, as it answered. */
  home: string;
  /** What it calls itself, and how it describes itself, in its own words. */
  company: string;
  about: string;
  /** Its own addresses, the best desk for a proposal first; each with whether its page refuses proposals. */
  found: (FoundAddress & { refuses: boolean })[];
};

const meta = (html: string, name: string): string => {
  const tag = new RegExp(`<meta\\b[^>]*(?:name|property)\\s*=\\s*["']${name}["'][^>]*>`, "i").exec(html)?.[0] ?? "";
  const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
  return pageText(content?.[1] ?? content?.[2] ?? "").slice(0, 400);
};

/** The words around an address, widely enough to hold a sentence about what it is not for. */
function around(text: string, email: string): string {
  const at = text.toLowerCase().indexOf(email);
  return at < 0 ? "" : text.slice(Math.max(0, at - 300), at + email.length + 300);
}

/**
 * What a site's robots.txt asks this reader to leave alone. Asked again for
 * every read, a pitch's included, so a site that closes itself to this
 * reader is closed from that moment, for every store.
 */
async function siteRules(origin: string, reader: PageReader): Promise<string[]> {
  const robots = await reader(`${origin}/robots.txt`);
  // A robots.txt that is really a web page (a site that answers everything with its front page) asks nothing.
  return robots && !/<html|<!doctype/i.test(robots.html.slice(0, 400)) ? robotsDisallows(robots.html) : [];
}

/**
 * Reads what a creator typed as the address of a business's website, and
 * returns what that business says of itself and where it asks to be written.
 */
/** A new owner-requested lookup, admitted before reading any external page. */
export async function readStoreSite(store: Store, raw: string, reader: PageReader = readPage): Promise<Awaited<ReturnType<typeof readSite>> | { ok: false; reason: "unavailable" }> {
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return { ok: false, reason: "unavailable" };
  return readSite(raw, reader);
}

export async function readSite(raw: string, reader: PageReader = readPage): Promise<{ ok: true; site: SiteRead } | { ok: false; reason: SiteProblem }> {
  let start: URL;
  try {
    const typed = raw.trim();
    start = checkUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return { ok: false, reason: "address" };
  }
  const front = await reader(`${start.origin}/`);
  if (!front) return { ok: false, reason: "unreadable" };
  const home = new URL(front.url);
  const disallows = await siteRules(home.origin, reader);
  if (!robotsAllows(disallows, home.pathname || "/")) return { ok: false, reason: "unreadable" };

  // The few pages its own menu points to, asked for together: each once, and none that robots.txt closes.
  const wanted = contactPages(front.html, front.url)
    .filter((url) => robotsAllows(disallows, new URL(url).pathname))
    .slice(0, MAX_PAGES_READ - 1);
  const others = await Promise.all(wanted.map((url) => reader(url)));
  const pages = [front, ...others.filter((page): page is { url: string; html: string } => page !== null && siteDomain(new URL(page.url).hostname) === siteDomain(home.hostname))];

  const found = new Map<string, FoundAddress & { refuses: boolean }>();
  // The contact and partner pages before the front page: the address printed
  // there is the one the business means for this.
  for (const page of [...pages.slice(1), pages[0]]) {
    const text = pageText(page.html);
    for (const address of publishedAddresses(page.html, page.url, home.hostname)) {
      if (!found.has(address.email)) found.set(address.email, { ...address, refuses: refusesProposals(around(text, address.email)) });
    }
  }
  const title = pageText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(front.html)?.[1] ?? "");
  const company = (meta(front.html, "og:site_name") || title.split(/\s[|–—·-]\s/)[0] || siteDomain(home.hostname)).slice(0, 120);
  const about = meta(front.html, "description") || meta(front.html, "og:description");
  return { ok: true, site: { domain: siteDomain(home.hostname), home: `${home.origin}/`, company, about, found: [...found.values()].slice(0, 12) } };
}

// ---- What is kept ---------------------------------------------------------------

const key = (statsId: string, part: string) => `nl:outreach:${statsId}:${part}`;
export const linkKey = (token: string) => `nl:outreach:stoplink:${token}`;
const STOP_ALL = "nl:outreach:stop:all";

/**
 * SISMEMBER on a stop list, only in its exact shape (CX-123 rule 24): 1 is
 * stopped, 0 is not, and anything else (null, "1", true, 2) is null, unknown.
 */
function stopOf(reply: unknown): boolean | null {
  return reply === 1 ? true : reply === 0 ? false : null;
}
/** What one pitch leaves in the store's data room for good: its stop link and a domain's place in the stop lists. */
export const OUTREACH_TRACE_BYTES = 640;
/** What a pitch weighs at the most, counted in the store's data room while it is kept: its words in any script, its footer, its record. */
export const PITCH_BYTES = (MAX_PITCH_BODY + MAX_PITCH_SUBJECT) * 3 + 3_072;
const PITCHES_SLOT = "op";
/** Where a pitch's stop link leads: a page with one press, on the platform's own address. */
export const stopUrl = (token: string) => `${SITE_URL}/outreach/stop/${token}`;
const dayOf = (now: number) => new Date(now * 1000).toISOString().slice(0, 10);

/** Who is writing. Starts from what the store's emails already carry, when it has that. */
export async function readSender(store: Store): Promise<Sender> {
  const fallback = cleanSender({ name: store.mail?.fromName || store.name, address: store.mail?.address ?? "" });
  if (!store.statsId || !isRedisConfigured()) return fallback;
  const [raw] = await redisPipeline([["GET", key(store.statsId, "me")]]);
  if (typeof raw !== "string") return fallback;
  try {
    const saved = cleanSender(JSON.parse(raw) as { name?: unknown; address?: unknown });
    return { name: saved.name || fallback.name, address: saved.address || fallback.address };
  } catch {
    return fallback;
  }
}

export async function saveSender(store: Store, raw: { name?: unknown; address?: unknown }): Promise<Sender | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const sender = cleanSender(raw);
  if (!sender.name || !sender.address) return null;
  // Said saved only on the exact receipt (Claude 1 on #2870, LOW): an unknown answer throws, the route answers 503.
  wroteSet(await redisPipeline([["SET", key(store.statsId, "me"), JSON.stringify(sender)]]), [["SET"]], "the sender");
  return sender;
}

/**
 * Every pitch a store keeps, the newest first. Read exactly (CX-123 rule 24):
 * the hash's field/value list, each value a pitch that reads. An unknown
 * reply or a kept pitch that does not read throws (UnknownReplyError), never
 * "no pitches": what is kept is what holds the wait before the same business
 * is written to again, a business's stop and MAX_PITCHES (startPitch). An
 * empty list is a store that keeps none.
 */
export async function listPitches(store: Store): Promise<Pitch[]> {
  if (!store.statsId || !isRedisConfigured()) return [];
  const all = stringList(repliesFor(await redisPipeline([["HGETALL", key(store.statsId, "pitches")]]), 1)?.[0]);
  if (!all || all.length % 2 !== 0) throw new UnknownReplyError("a store's pitches");
  const pitches: Pitch[] = [];
  for (let i = 1; i < all.length; i += 2) {
    const pitch = parsePitch(all[i]);
    // Every writer keeps when a pitch was made, and when a sent or stopped one went out (Codex Q on #2870): one kept
    // without them would count as written long ago and let the same business be written to again before its wait.
    if (!pitch || !(pitch.createdAt > 0) || (pitch.status !== "draft" && !(pitch.sentAt > 0))) throw new UnknownReplyError("a store's pitches");
    // A status this code never writes ("Sent", or none) is unknown, never a draft with no wait (Claude 6 on #2870).
    if (!keptStatusKnown(all[i])) throw new UnknownReplyError("a store's pitches");
    pitches.push(pitch);
  }
  return pitches.sort((a, b) => b.createdAt - a.createdAt);
}

/** Whether a kept pitch's own status is one this code writes (parsePitch reads any other as a draft). */
function keptStatusKnown(raw: string): boolean {
  try {
    const status = (JSON.parse(raw) as { status?: unknown }).status;
    return PITCH_STATUSES.includes(status as PitchStatus);
  } catch {
    return false;
  }
}

export type StartResult =
  /** `replaced`: drafts to the same business that this one took the place of. */
  | { ok: true; pitch: Pitch; left: number; replaced: string[] }
  | { ok: false; reason: PitchProblem | SiteProblem | "unpublished" | "off" | "used" | "failed" | "notes" | "full" | "room" | "busy" | "unavailable" };

/**
 * Writes one pitch, after everything that could forbid it has been asked.
 *
 * The address is not taken from the browser's word: the page it was said to
 * be on is read again here, and the pitch is written only when that page, at
 * the business's own domain, still prints that address. What it printed
 * around it, and when, are kept with the pitch: in Canada and Australia the
 * one who writes has to be able to show the address was published.
 */
export async function startPitch(
  store: Store,
  input: { goal: OutreachGoal; country: string; isCompany: boolean; page: string; email: string; company: string; about: string; notes: string },
  options: { reader?: PageReader; now?: number } = {},
): Promise<StartResult> {
  if (!store.statsId || !isRedisConfigured()) return { ok: false, reason: "off" };
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const country: CountryRule = countryRule(input.country);
  // Asked before anything is read: a country that is closed needs no page.
  if (!country.allowed) return { ok: false, reason: "country" };

  let page: URL;
  try {
    page = checkUrl(input.page);
  } catch {
    return { ok: false, reason: "address" };
  }
  const email = input.email.trim().toLowerCase();
  if (!isOwnAddress(email, page.hostname)) return { ok: false, reason: "unpublished" };
  const pageDomain = siteDomain(page.hostname);

  // Asked before the paid window is reserved, so a refusal here reserves nothing: the stop lists for the page's own
  // domain and the day's count, read only in their exact shape (CX-123 rule 24). A business is "not stopped" only on
  // an exact 0 from both lists, and the day's count is a whole number, or no key at all (nothing written today: INCR
  // makes it with the first). Anything else refuses, never "not stopped" or "0 written today".
  const [sender, pitches, replies] = await Promise.all([
    readSender(store),
    // Kept pitches that cannot be read are not "none" (CX-123 rule 24): refused below, like the stop lists.
    listPitches(store).catch((error: unknown) => {
      if (error instanceof UnknownReplyError) return null;
      throw error;
    }),
    redisPipeline([
      ["SISMEMBER", key(store.statsId, "stop"), pageDomain],
      ["GET", key(store.statsId, `day:${dayOf(now)}`)],
      ["SISMEMBER", STOP_ALL, pageDomain],
    ]),
  ]);
  const answered = repliesFor(replies, 3);
  const mine = answered ? stopOf(answered[0]) : null;
  const all = answered ? stopOf(answered[2]) : null;
  const today = answered ? textCountOf(answered[1]) : null;
  if (pitches === null || mine === null || all === null || today === null) return { ok: false, reason: "unavailable" };
  // The country was asked already; a stop is the next thing pitchProblem would refuse for.
  if (mine || all) return { ok: false, reason: "stopped" };

  // New draft work must be funded before even verifying its external page.
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return { ok: false, reason: "unavailable" };
  const reader = options.reader ?? readPage;
  if (!robotsAllows(await siteRules(page.origin, reader), `${page.pathname || "/"}${page.search}`)) return { ok: false, reason: "unreadable" };
  const read = await reader(page.toString());
  if (!read) return { ok: false, reason: "unreadable" };
  const address = publishedAddresses(read.html, read.url, new URL(read.url).hostname).find((a) => a.email === email);
  if (!address) return { ok: false, reason: "unpublished" };
  const domain = siteDomain(new URL(read.url).hostname);
  // Read again after the page (Codex G on #2697): a stop asked for, or a pitch counted, while it was read stands, so
  // the model is never asked on a state read before it. One round trip, with the stop lists of the domain the reader
  // was sent on to when it is another one, all in the same exact shape.
  // The same three reads as before the page, in the same order, then the other domain's two when there is one.
  // Cost (rule MR; Codex G's LEVE on #2697): this round trip is 3 commands, 5 when the reader was sent on to another
  // domain. It runs once per draft attempt that got past the checks above and read the page, and draft attempts are held
  // by the store's "ai" limit (AI_PER_MINUTE, app/api/store/outreach/route.ts), not by FINDS_PER_DAY (find only) nor by
  // PITCHES_PER_DAY (drafts kept, not attempts refused here). The "ai" window is 60 s from its first use, not a clock
  // minute, so a calendar day can meet 1,441 windows (Codex G on #2697). Ceiling: 6 × 1,441 = 8,646 attempts × 5 =
  // 43,230 commands a store a day, $0.0865 at Upstash's advertised $0.20 per 100,000
  // (docs/pack-cost-decomposition-2026-10-18.md), about $2.68 in a 31-day month, on top of the page read each attempt
  // already makes. Other gates (the month's AI allowance, the paid resource window) can only lower it. The common case
  // is a handful.
  const elsewhere: (string | number)[][] = domain === pageDomain ? [] : [["SISMEMBER", key(store.statsId, "stop"), domain], ["SISMEMBER", STOP_ALL, domain]];
  const fresh = repliesFor(
    await redisPipeline([
      ["SISMEMBER", key(store.statsId, "stop"), pageDomain],
      ["GET", key(store.statsId, `day:${dayOf(now)}`)],
      ["SISMEMBER", STOP_ALL, pageDomain],
      ...elsewhere,
    ]),
    3 + elsewhere.length,
  );
  if (!fresh) return { ok: false, reason: "unavailable" };
  const todayNow = textCountOf(fresh[1]);
  const stops = [fresh[0], fresh[2], ...fresh.slice(3)].map(stopOf);
  if (todayNow === null || stops.some((stop) => stop === null)) return { ok: false, reason: "unavailable" };
  if (stops[0] || stops[1]) return { ok: false, reason: "stopped" };
  const stoppedThere = stops.slice(2).some(Boolean);
  const before = pitches.filter((p) => p.domain === domain && p.status !== "draft");
  const problem = pitchProblem({
    country,
    address,
    isCompany: input.isCompany,
    pageRefuses: refusesProposals(around(pageText(read.html), email)),
    stopped: stoppedThere || pitches.some((p) => p.domain === domain && p.status === "stopped"),
    lastWrittenAt: before.length ? Math.max(...before.map((p) => p.sentAt || p.createdAt)) : null,
    sentToday: todayNow === "absent" ? 0 : todayNow,
    sender,
    now,
  });
  if (problem) return { ok: false, reason: problem };
  // Room is made by the oldest that came to nothing; a store whose every
  // pitch is still live has none to give up.
  const spare = pitches.filter((p) => p.status === "draft" || p.status === "sent").sort((a, b) => a.createdAt - b.createdAt);
  if (pitches.length >= MAX_PITCHES && spare.length === 0) return { ok: false, reason: "full" };

  // What a pitch leaves for as long as the store is, taken before the writing
  // job is paid for (lib/store-data.ts): its stop link, which is never
  // forgotten, and the domain's place among those that asked to stop.
  const trace = await takeData(store, [{ slot: "off", bytes: OUTREACH_TRACE_BYTES }, { slot: PITCHES_SLOT, bytes: PITCH_BYTES }]);
  if (!trace.ok) return { ok: false, reason: trace.reason === "full" ? "room" : "busy" };
  const titles = [...(await readTitles(store).catch(() => new Map<string, string>())).values()];
  const written = await writePitch(
    store,
    {
      goal: input.goal,
      sender: sender.name,
      company: input.company,
      about: input.about,
      sells: titles,
      commission: store.affiliates.enabled ? store.affiliates.percent : null,
      notes: input.notes,
    },
    now * 1000,
  );
  if (!written.ok) {
    await giveData(store, [{ slot: "off", bytes: OUTREACH_TRACE_BYTES }, { slot: PITCHES_SLOT, bytes: PITCH_BYTES }]);
    return { ok: false, reason: written.reason };
  }

  // One pitch to a business at a time: a new draft takes the place of an older one to the same domain.
  const replaced = pitches.filter((p) => p.domain === domain && p.status === "draft");
  const stop = randomBytes(16).toString("hex");
  const pitch: Pitch = {
    id: randomBytes(8).toString("hex"),
    goal: input.goal,
    domain,
    company: input.company.replace(/\s+/g, " ").trim().slice(0, 120) || domain,
    to: email,
    role: address.role,
    country: country.code,
    page: read.url,
    line: address.line,
    foundAt: now,
    subject: written.value.subject,
    body: written.value.body,
    footer: pitchFooter({ sender, storeUrl: storeBase(store), page: read.url, country, stopUrl: stopUrl(stop) }),
    stop,
    status: "draft",
    createdAt: now,
    sentAt: 0,
  };
  const pushedOut = pitches.length - replaced.length >= MAX_PITCHES && spare.some((p) => !replaced.includes(p)) ? spare.find((p) => !replaced.includes(p))! : null;
  const commands: (string | number)[][] = [
    ["HSET", key(store.statsId, "pitches"), pitch.id, JSON.stringify(pitch)],
    ["INCR", key(store.statsId, `day:${dayOf(now)}`)],
    ["EXPIRE", key(store.statsId, `day:${dayOf(now)}`), 3 * 86_400],
    ["SET", linkKey(stop), JSON.stringify({ s: store.statsId, id: pitch.id, d: domain, n: (store.mail?.fromName || store.name).slice(0, 80) })],
    ...replaced.flatMap((p) => [["HDEL", key(store.statsId!, "pitches"), p.id], ...(p.stop ? [["DEL", linkKey(p.stop)]] : [])]),
    ...(pushedOut ? [["HDEL", key(store.statsId, "pitches"), pushedOut.id]] : []),
  ];
  // Said written only on the exact receipt (Claude 1 on #2870): a draft shown with a stop link that may not open, or
  // with no wait held before the same business, is never answered done. The room taken stays taken (fails safe).
  const receipt = wroteSet(await redisPipeline(commands), commands, "a new pitch");
  // The pitches let go give their room back; their stop links stay counted (OUTREACH_TRACE_BYTES). Only those this
  // write removed, on their own HDEL's 1: a 0 is a drop that got there first and gave the room back already.
  const gone = commands.filter((command, i) => command[0] === "HDEL" && receipt[i] === 1).length;
  if (gone > 0) await giveData(store, [{ slot: PITCHES_SLOT, bytes: gone * PITCH_BYTES }]);
  return { ok: true, pitch, left: written.left, replaced: replaced.map((p) => p.id) };
}

/** The creator's own changes to a pitch they have not sent yet. The footer is not theirs to change. */
export async function editPitch(store: Store, id: string, subject: string, body: string): Promise<Pitch | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const pitch = parsePitch(await keptPitch(store.statsId, id));
  if (!pitch || pitch.status !== "draft") return null;
  const next: Pitch = {
    ...pitch,
    subject: subject.replace(/\s+/g, " ").trim().slice(0, MAX_PITCH_SUBJECT) || pitch.subject,
    body: body.replace(/\r\n?/g, "\n").trim().slice(0, MAX_PITCH_BODY) || pitch.body,
  };
  wrote(await redisPipeline([["HSET", key(store.statsId, "pitches"), id, JSON.stringify(next)]]), 1, "a pitch's edit");
  return next;
}

/**
 * One kept pitch, read exactly (Claude 6 on #2870, rule 24): nil (not there) or its text; any other answer throws,
 * never "no such pitch".
 */
async function keptPitch(statsId: string, id: string): Promise<string | null> {
  const raw = repliesFor(await redisPipeline([["HGET", key(statsId, "pitches"), id]]), 1)?.[0];
  if (raw !== null && typeof raw !== "string") throw new UnknownReplyError("a kept pitch");
  return raw;
}

/** A write's receipt: one count for each command, or it throws, so a change is never said done on an unknown answer. */
function wrote(replies: unknown, length: number, what: string): number[] {
  const receipt = repliesFor(replies, length);
  const counts = receipt?.map((reply) => countOf(reply));
  if (!counts || counts.some((count) => count === null)) throw new UnknownReplyError(what);
  return counts as number[];
}

/** A write's receipt where a SET answers "OK" and every other command a count, read in order; anything else throws. */
function wroteSet(replies: unknown, commands: (string | number)[][], what: string): (number | "OK")[] {
  const receipt = repliesFor(replies, commands.length);
  const read = receipt?.map((reply, i) => (commands[i][0] === "SET" ? (reply === "OK" ? "OK" : null) : countOf(reply)));
  if (!read || read.some((reply) => reply === null)) throw new UnknownReplyError(what);
  return read as (number | "OK")[];
}

/**
 * What became of a pitch. "stopped" is kept for good, under the business's
 * domain, and closes it to this store: the answer to "please do not write
 * again" is that nothing here can.
 */
export async function setPitchStatus(store: Store, id: string, status: PitchStatus, now = Math.floor(Date.now() / 1000)): Promise<Pitch | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const pitch = parsePitch(await keptPitch(store.statsId, id));
  if (!pitch) return null;
  // Once they asked to stop, it stays stopped.
  if (pitch.status === "stopped") return pitch;
  const next: Pitch = { ...pitch, status, sentAt: status === "draft" ? 0 : pitch.sentAt || now };
  // Said done only on the exact receipt (Claude 6 on #2870): "stopped" is a business's opt-out and "sent" starts the
  // wait before the same business is written to again, so neither is answered done on a write not known to land.
  const commands: (string | number)[][] = [
    ["HSET", key(store.statsId, "pitches"), id, JSON.stringify(next)],
    ...(status === "stopped" ? [["SADD", key(store.statsId, "stop"), pitch.domain]] : []),
  ];
  wrote(await redisPipeline(commands), commands.length, "a pitch's status");
  return next;
}

/** Takes a draft away. Only a draft: what was sent stays, so the same business is not written to twice. */
export async function dropPitch(store: Store, id: string): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const pitch = parsePitch(await keptPitch(store.statsId, id));
  if (!pitch || pitch.status !== "draft") return false;
  const commands: (string | number)[][] = [["HDEL", key(store.statsId, "pitches"), id], ...(pitch.stop ? [["DEL", linkKey(pitch.stop)]] : [])];
  // The room is given back only for a drop known to have removed it (Claude 6 on #2870); another drop that got
  // there first gave it back already.
  const [removed] = wrote(await redisPipeline(commands), commands.length, "a pitch's drop");
  if (removed !== 1) return false;
  await giveData(store, [{ slot: PITCHES_SLOT, bytes: PITCH_BYTES }]);
  return true;
}

// ---- The business's own way out ---------------------------------------------------

type StopLink = { s: string; id: string; d: string; n: string };

/**
 * A stop link, read exactly (Claude 5 on #2968, rule 24): null only for a key that is not one (Redis nil); a reply
 * in another shape, or text that is not a link this code writes, throws, never "not one we know", so the page keeps
 * both stop buttons and a press answers done=0.
 */
async function readLink(token: string): Promise<StopLink | null> {
  if (!STOP_LINK.test(token)) return null;
  if (!isRedisConfigured()) throw new UnknownReplyError("a stop link (no store to read it from)");
  const raw = repliesFor(await redisPipeline([["GET", linkKey(token)]]), 1)?.[0];
  if (raw === null) return null;
  if (typeof raw !== "string") throw new UnknownReplyError("a stop link");
  let v: Partial<StopLink>;
  try {
    v = JSON.parse(raw) as Partial<StopLink>;
  } catch {
    throw new UnknownReplyError("a stop link");
  }
  if (!v || typeof v !== "object" || typeof v.s !== "string" || typeof v.id !== "string" || typeof v.d !== "string") throw new UnknownReplyError("a stop link");
  return { s: v.s, id: v.id, d: v.d, n: typeof v.n === "string" ? v.n : "" };
}

/** What the page behind a stop link says: who wrote, to which business, and what is already closed. */
export async function readStopLink(token: string): Promise<{ domain: string; storeName: string; stopped: boolean; everyone: boolean } | null> {
  const link = await readLink(token);
  if (!link) return null;
  const answered = repliesFor(
    await redisPipeline([
      ["SISMEMBER", key(link.s, "stop"), link.d],
      ["SISMEMBER", STOP_ALL, link.d],
    ]),
    2,
  );
  // A stop is said to hold only on an exact 1 (CX-123 rule 24). An unknown answer is never shown as a stop: the page
  // then keeps both stop buttons, and pressing one again only adds what is already there (stopFromLink, SADD).
  const mine = answered ? stopOf(answered[0]) === true : false;
  const all = answered ? stopOf(answered[1]) === true : false;
  return { domain: link.d, storeName: link.n, stopped: mine || all, everyone: all };
}

/**
 * The link in a pitch's footer, pressed by the business it was sent to. It
 * closes that business to the store that wrote, and, when asked, to every
 * store here, for good. Nobody at the store has to see it, agree to it or
 * do anything for it to hold: the next pitch to that domain is refused
 * where it is written (startPitch).
 */
export async function stopFromLink(token: string, everyone: boolean, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const link = await readLink(token);
  if (!link) return false;
  // Read and written exactly (CX-123 rule 24; J and Codex Q on #2870): the pitch is nil or a string, and the write
  // answers one count for each command. Anything else throws, so the stop is never said done on a write whose answer
  // is not known (the route then answers done=0, and pressing again only adds what may already be there).
  const raw = repliesFor(await redisPipeline([["HGET", key(link.s, "pitches"), link.id]]), 1)?.[0];
  if (raw !== null && typeof raw !== "string") throw new UnknownReplyError("the pitch a stop link names");
  const pitch = parsePitch(raw);
  const writes: (string | number)[][] = [
    ["SADD", key(link.s, "stop"), link.d],
    ...(everyone ? [["SADD", STOP_ALL, link.d]] : []),
    ...(pitch && pitch.status !== "stopped" ? [["HSET", key(link.s, "pitches"), link.id, JSON.stringify({ ...pitch, status: "stopped", sentAt: pitch.sentAt || now } satisfies Pitch)]] : []),
  ];
  const receipt = repliesFor(await redisPipeline(writes), writes.length);
  if (!receipt || !receipt.every((reply) => countOf(reply) !== null)) throw new UnknownReplyError("a business's stop");
  return true;
}
