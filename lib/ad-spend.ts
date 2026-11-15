/**
 * Where what a creator spent on ads is kept (lib/ad-spend-rules.ts says what
 * it is for). One field for each entry, so two people adding at once both
 * keep theirs; at most MAX_SPEND_ENTRIES, the oldest let go; kept as long as
 * the days of visits are, counted from the last entry added. Shown only in
 * the studio.
 *
 * What the store's Meta ad account spent is read into lines of its own
 * (lib/meta-ads.ts), and readSpends hands them back with the typed ones,
 * marked source "meta", so every figure that uses spend uses both. They
 * cannot be removed one by one: they go with the connection.
 *
 *   nl:stats:<statsId>:spend   hash: <id> → JSON { channel, campaign, cents, from, to }
 *
 * <id> is the add's operation id from the studio (OP: 32 hex characters, kept across the tries of one add, new for a
 * new add), or, for a request without one, 8 hex characters chosen here.
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type AdSpend, MAX_SPEND_ENTRIES, readSpend, type SpendUnread } from "@/lib/ad-spend-rules";
import { metaLines } from "@/lib/meta-ads";

const key = (statsId: string) => `nl:stats:${statsId}:spend`;
const ID = /^(?:[a-f0-9]{8}|[a-f0-9]{32})$/;
/** An add's operation id, as components/ad-spend-editor.tsx makes it (Codex Z on #2924; C1-20261107-2118-C4-1 item 5). */
const OP = /^[a-f0-9]{32}$/;
const KEEP_SECONDS = 400 * 86_400;

/**
 * The typed entries of a hash's fields and values, whole or not at all (CX-123 rule 24; Codex Z on #2924): every
 * field an id and every value an entry this code writes, or null (unknown), never the other entries as if they were
 * all of it.
 */
export function parseSpends(raw: unknown): AdSpend[] | null {
  return parseAllSpends(raw)?.slice(-MAX_SPEND_ENTRIES) ?? null;
}

/** Every typed entry of a hash, whole or not at all (as parseSpends), before the list is cut to the newest. */
function parseAllSpends(raw: unknown): AdSpend[] | null {
  const split = splitSpends(raw);
  return split && !split.unreadable.length ? split.spends : null;
}

/**
 * A hash reply split into the entries that read and the fields whose entry does not (a field this code does not write,
 * or a value in another shape); null when the reply itself is not a hash's fields and values, so nothing is known.
 */
function splitSpends(raw: unknown): { spends: AdSpend[]; unreadable: string[] } | null {
  if (!Array.isArray(raw) || raw.length % 2 !== 0) return null;
  const spends: AdSpend[] = [];
  const unreadable: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [field, text] = [raw[i], raw[i + 1]];
    if (typeof field !== "string" || typeof text !== "string") return null;
    const spend = ID.test(field) ? entryOf(text) : null;
    if (spend) spends.push({ id: field, ...spend });
    else unreadable.push(field);
  }
  return { spends: spends.sort(byDay), unreadable };
}

/** One kept value read back through the same rule it was written by, with no "now": never refused for its age. */
function entryOf(text: string): Omit<AdSpend, "id"> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const read = readSpend({ channel: v.channel, campaign: v.campaign, cents: v.cents, from: v.from, to: v.to }, Number.MAX_SAFE_INTEGER);
  return read.ok ? read.spend : null;
}

/**
 * Thrown where the typed entries' hash read whole but some of its entries did not: how many, so the editor can offer
 * to remove exactly those by their keys (removeUnreadableSpends). Their amounts are unknown and never guessed.
 */
export class UnreadableSpendsError extends UnknownReplyError {
  constructor(readonly count: number) {
    super("the ad spend typed");
    this.name = "UnreadableSpendsError";
  }
}

const byDay = (a: AdSpend, b: AdSpend) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id);

/** The typed lines only, read exactly (CX-123 rule 24): a hash reply, or a member of it, in another shape throws, never "no lines". */
async function typedSpends(statsId: string): Promise<AdSpend[]> {
  return (await keptSpends(statsId)).slice(-MAX_SPEND_ENTRIES);
}

/** Every typed entry kept, read exactly, before the list is cut to the newest. */
async function keptSpends(statsId: string): Promise<AdSpend[]> {
  const split = await splitKept(statsId);
  if (split.unreadable.length) throw new UnreadableSpendsError(split.unreadable.length);
  return split.spends;
}

/** The typed entries' hash read exactly, split into what reads and what does not; a reply in another shape throws. */
async function splitKept(statsId: string): Promise<{ spends: AdSpend[]; unreadable: string[] }> {
  const split = splitSpends(stringList(repliesFor(await redisPipeline([["HGETALL", key(statsId)]]), 1)?.[0]));
  if (!split) throw new UnknownReplyError("the ad spend typed");
  return split;
}

/** What spend was read: every line known, or the typed ones with Meta's unread (`metaUnread`), never Meta's as 0. */
export type SpendRead = { spends: AdSpend[]; metaUnread: boolean };

/** What every page or answer says when Meta's lines could not be read: the figures that use spend are incomplete. */
export const META_SPEND_UNREAD = "Ad spend from your Meta ad account could not be read just now, so the figures that use ad spend are not shown. Reload to try again.";

/**
 * Every line: the typed ones, then those read from Meta while the store is
 * connected. Meta's lines that cannot be read just now leave `metaUnread` set
 * and the typed lines alone, for the caller to say so; typed lines that
 * cannot be read throw (UnknownReplyError).
 */
export async function readSpendLines(statsId: string | null): Promise<SpendRead> {
  if (!statsId || !isRedisConfigured()) return { spends: [], metaUnread: false };
  const [typed, meta] = await Promise.all([
    typedSpends(statsId),
    metaLines(statsId).catch((error: unknown) => {
      console.error("reading Meta's ad spend lines failed", error);
      return null;
    }),
  ]);
  return meta ? { spends: [...typed, ...meta], metaUnread: false } : { spends: typed, metaUnread: true };
}

/**
 * The lines alone, Meta's unread ones left out; typed lines that cannot be read throw. No page reads spend this
 * way: callers that show figures use readSpendLines, spendsForStudio or spendsForReport, which say what is unread.
 */
export async function readSpends(statsId: string | null): Promise<AdSpend[]> {
  return (await readSpendLines(statsId)).spends;
}

/**
 * The spend for the studio's numbers (app/studio/page.tsx): every line with nothing unread; the typed lines with
 * `unread: "meta"` when Meta's could not be read; none with `unread: "typed"` when the typed ones could not be (any
 * failure of that read, so the page still loads). The numbers panel leaves out every figure that uses ad spend while
 * a part is unread, never one part as all of it or everything as $0 (Claude 5 on #2924).
 */
export async function spendsForStudio(statsId: string | null): Promise<{ spends: AdSpend[]; unread: SpendUnread }> {
  try {
    const read = await readSpendLines(statsId);
    return { spends: read.spends, unread: read.metaUnread ? "meta" : null };
  } catch (error) {
    console.error("reading ad spend for the studio failed", error);
    return { spends: [], unread: "typed" };
  }
}

/**
 * The spend for the weekly email (app/api/cron/weekly/route.ts): every line,
 * or none at all when any part could not be read, typed or Meta's, so the
 * figures that use ad spend are left out of it, never shown with one part as
 * all of it or everything as $0 (Claude 5 on #2924).
 */
export async function spendsForReport(statsId: string | null): Promise<AdSpend[]> {
  const read = await readSpendLines(statsId).catch((error: unknown) => {
    console.error("reading ad spend for the weekly email failed", error);
    return null;
  });
  return read && !read.metaUnread ? read.spends : [];
}

/**
 * Writes one new line under its fresh id and answers whether it is saved, from the write's exact receipt only
 * (Codex Z on #2924): HSET adding the one field and EXPIRE setting the time, [1, 1]. A receipt lost (the pipeline
 * threw after Redis may have applied it) or in any other shape is never "saved": the line is deleted by its own id,
 * which no other line has, and false is answered only once that HDEL's reply is a count, so nothing of this add is
 * kept and trying again records the expense once. When that reply is unknown too, whether the line is kept is
 * unknown, and it throws (UnknownReplyError: reload to see where it stands), never "saved" nor "nothing saved".
 * When the write's own round trip failed, the write may still be on its way (Codex Z on #2924): an HDEL that finds
 * nothing (0) proves only that it has not landed yet, so that outcome is unknown too; only an HDEL that removed the
 * line (1), or a write that answered in some shape (it ran), lets the add be refused as nothing saved.
 */
async function written(statsId: string, id: string, value: string): Promise<boolean> {
  let unresolved = false;
  const receipt = await redisPipeline([
    ["HSET", key(statsId), id, value],
    ["EXPIRE", key(statsId), KEEP_SECONDS],
  ]).then(
    (replies) => repliesFor(replies, 2),
    (error: unknown) => {
      console.error("writing an ad spend line answered no receipt", error);
      unresolved = true;
      return null;
    },
  );
  if (receipt && receipt[0] === 1 && receipt[1] === 1) return true;
  const undone = await redisPipeline([["HDEL", key(statsId), id]]).then(
    (replies) => repliesFor(replies, 1),
    () => null,
  );
  const count = undone?.[0];
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 1 || (unresolved && count === 0)) {
    throw new UnknownReplyError("writing an ad spend line");
  }
  return false;
}

/**
 * Keeps one add's line under its operation id, once (Codex Z on #2924): HSETNX never writes a second line for an id
 * already kept, so a try of the same add that lands late, or is sent again, adds nothing. Saved only on the exact
 * receipt: [1, 1] (written now) or [0, 1] (another try of this same add was kept first), EXPIRE setting the time. Any
 * other receipt, or none, is unknown and throws (UnknownReplyError), and the line is never undone: under an id the
 * tries share, an undoing could take away a try that saved. Trying the same add again is what is safe.
 */
async function keptOnce(statsId: string, op: string, value: string): Promise<void> {
  const receipt = await redisPipeline([
    ["HSETNX", key(statsId), op, value],
    ["EXPIRE", key(statsId), KEEP_SECONDS],
  ]).then(
    (replies) => repliesFor(replies, 2),
    (error: unknown) => {
      console.error("writing an ad spend line answered no receipt", error);
      return null;
    },
  );
  if (!receipt || (receipt[0] !== 1 && receipt[0] !== 0) || receipt[1] !== 1) throw new UnknownReplyError("writing an ad spend line");
}

export async function addSpend(
  statsId: string,
  input: { channel: unknown; campaign?: unknown; cents: unknown; from: unknown; to: unknown; op?: unknown },
  now = Date.now(),
): Promise<({ ok: true } & SpendRead) | { ok: false; reason: "channel" | "amount" | "days" | "unavailable" }> {
  const read = readSpend(input, now);
  if (!read.ok) return read;
  if (!isRedisConfigured()) return { ok: false, reason: "unavailable" };
  // What is kept is read exactly before anything is written (Claude 5 on #2924): a list that cannot be read refuses
  // the add, so a refusal always means nothing was saved and the creator is never led to save the same line again.
  const before = await keptSpends(statsId);
  const op = typeof input.op === "string" && OP.test(input.op) ? input.op : null;
  let id: string;
  if (op) {
    // An add with the studio's operation id: kept once under it, and not written again once it is kept.
    id = op;
    if (!before.some((s) => s.id === op)) await keptOnce(statsId, op, JSON.stringify(read.spend));
  } else {
    // No operation id (an older page): a fresh id no kept line has, so this add's write and its undoing touch only
    // this add's own line.
    id = randomBytes(4).toString("hex");
    while (before.some((s) => s.id === id)) id = randomBytes(4).toString("hex");
    if (!(await written(statsId, id, JSON.stringify(read.spend)))) return { ok: false, reason: "unavailable" };
  }
  const known = (before.some((s) => s.id === id) ? before : [...before, { id, ...read.spend }]).sort(byDay);
  const keep = known.slice(-MAX_SPEND_ENTRIES);
  const drop = known.slice(0, known.length - keep.length).map((s) => s.id);
  // The line is saved by now: a prune that fails is logged, never answered "not saved" (Claude 5 on #2924, LEVE B).
  // Reading cuts the list to the newest MAX_SPEND_ENTRIES, and the next add prunes again.
  if (drop.length) {
    await redisPipeline([["HDEL", key(statsId), ...drop]]).catch((error: unknown) => {
      console.error("pruning the oldest ad spend lines failed", error);
    });
  }
  try {
    return { ok: true, ...(await readSpendLines(statsId)) };
  } catch (error) {
    // Saved: a read after the write that fails answers the lines known from the read before it, never "not saved".
    console.error("reading the ad spend back after adding failed", error);
    const meta = await metaLines(statsId).catch(() => null);
    return { ok: true, spends: [...keep, ...(meta ?? [])], metaUnread: !meta };
  }
}

/**
 * Removes the typed entries that cannot be read, by their keys, never by a guessed amount: the hash is read exactly
 * at that moment and only the fields whose entry does not read are deleted, with a confirmed HDEL. Every entry that
 * reads stays. A hash read in another shape, or an HDEL answered in no known shape, throws (UnknownReplyError).
 * Entries are written once under a fresh random key, so a field that does not read now is never one being saved.
 */
export async function removeUnreadableSpends(statsId: string): Promise<SpendRead> {
  if (!isRedisConfigured()) return { spends: [], metaUnread: false };
  const { unreadable } = await splitKept(statsId);
  if (unreadable.length) {
    const removed = repliesFor(await redisPipeline([["HDEL", key(statsId), ...unreadable]]), 1);
    if (!removed || countOf(removed[0]) === null) throw new UnknownReplyError("removing the unreadable ad spend entries");
  }
  return readSpendLines(statsId);
}

export async function removeSpend(statsId: string, id: unknown): Promise<SpendRead> {
  if (typeof id === "string" && ID.test(id) && isRedisConfigured()) await redisPipeline([["HDEL", key(statsId), id]]);
  return readSpendLines(statsId);
}
