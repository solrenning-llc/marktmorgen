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
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { type AdSpend, MAX_SPEND_ENTRIES, readSpend } from "@/lib/ad-spend-rules";
import { metaLines } from "@/lib/meta-ads";

const key = (statsId: string) => `nl:stats:${statsId}:spend`;
const ID = /^[a-f0-9]{8}$/;
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
  if (!Array.isArray(raw) || raw.length % 2 !== 0) return null;
  const out: AdSpend[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [field, text] = [raw[i], raw[i + 1]];
    if (typeof field !== "string" || !ID.test(field) || typeof text !== "string") return null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    // Read back through the same rule it was written by, with no "now": a kept entry is never refused for its age.
    const v = value as Record<string, unknown>;
    const read = readSpend({ channel: v.channel, campaign: v.campaign, cents: v.cents, from: v.from, to: v.to }, Number.MAX_SAFE_INTEGER);
    if (!read.ok) return null;
    out.push({ id: field, ...read.spend });
  }
  return out.sort(byDay);
}

const byDay = (a: AdSpend, b: AdSpend) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id);

/** The typed lines only, read exactly (CX-123 rule 24): a hash reply, or a member of it, in another shape throws, never "no lines". */
async function typedSpends(statsId: string): Promise<AdSpend[]> {
  return (await keptSpends(statsId)).slice(-MAX_SPEND_ENTRIES);
}

/** Every typed entry kept, read exactly, before the list is cut to the newest. */
async function keptSpends(statsId: string): Promise<AdSpend[]> {
  const spends = parseAllSpends(stringList(repliesFor(await redisPipeline([["HGETALL", key(statsId)]]), 1)?.[0]));
  if (!spends) throw new UnknownReplyError("the ad spend typed");
  return spends;
}

/** What spend was read: every line known, or the typed ones with Meta's unread (`metaUnread`), never Meta's as 0. */
export type SpendRead = { spends: AdSpend[]; metaUnread: boolean };

/** What every page or answer says when Meta's lines could not be read: the figures that use spend are incomplete. */
export const META_SPEND_UNREAD = "Ad spend from your Meta ad account could not be read just now, so the figures that use ad spend leave it out. Reload to try again.";

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
 * The lines alone, for a caller that cannot yet say a part is missing
 * (app/studio/page.tsx, held by other work): Meta's unread lines are left out
 * there. New callers use readSpendLines and say META_SPEND_UNREAD.
 */
export async function readSpends(statsId: string | null): Promise<AdSpend[]> {
  return (await readSpendLines(statsId)).spends;
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

export async function addSpend(
  statsId: string,
  input: { channel: unknown; campaign?: unknown; cents: unknown; from: unknown; to: unknown },
  now = Date.now(),
): Promise<({ ok: true } & SpendRead) | { ok: false; reason: "channel" | "amount" | "days" | "unavailable" }> {
  const read = readSpend(input, now);
  if (!read.ok) return read;
  if (!isRedisConfigured()) return { ok: false, reason: "unavailable" };
  // What is kept is read exactly before anything is written (Claude 5 on #2924): a list that cannot be read refuses
  // the add, so a refusal always means nothing was saved and the creator is never led to save the same line again.
  const before = await keptSpends(statsId);
  const id = randomBytes(4).toString("hex");
  await redisPipeline([
    ["HSET", key(statsId), id, JSON.stringify(read.spend)],
    ["EXPIRE", key(statsId), KEEP_SECONDS],
  ]);
  const known = [...before, { id, ...read.spend }].sort(byDay);
  const keep = known.slice(-MAX_SPEND_ENTRIES);
  const drop = known.slice(0, known.length - keep.length).map((s) => s.id);
  if (drop.length) await redisPipeline([["HDEL", key(statsId), ...drop]]);
  try {
    return { ok: true, ...(await readSpendLines(statsId)) };
  } catch (error) {
    // Saved: a read after the write that fails answers the lines known from the read before it, never "not saved".
    console.error("reading the ad spend back after adding failed", error);
    const meta = await metaLines(statsId).catch(() => null);
    return { ok: true, spends: [...keep, ...(meta ?? [])], metaUnread: !meta };
  }
}

export async function removeSpend(statsId: string, id: unknown): Promise<SpendRead> {
  if (typeof id === "string" && ID.test(id) && isRedisConfigured()) await redisPipeline([["HDEL", key(statsId), id]]);
  return readSpendLines(statsId);
}
