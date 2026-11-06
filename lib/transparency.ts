/**
 * Counts for the public transparency page (624 [SZ8](47)): notices of
 * content on a store that we received, and those we acted on, year by year.
 * Only what is counted, as it happens (lib/takedown.ts): a notice when it is
 * filed, a notice acted on once however many steps were taken, and each kind
 * of step. Nothing about who sent a notice or which store it named.
 *
 *   nl:transparency:<YYYY>          hash  notice:<kind>, acted:<kind> (copyright, other), step:<type>
 *   nl:transparency:acted:<YYYY>    set   the notices acted on that year, so each counts once
 *   nl:transparency:since           ISO day counting began
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { REPORT_KINDS, type ReportKind } from "@/lib/takedown-rules";

export type NoticeKind = ReportKind;
export type StepType = "link" | "product" | "kit" | "store";
export const NOTICE_KINDS: readonly NoticeKind[] = REPORT_KINDS;
export const STEP_TYPES: readonly StepType[] = ["link", "product", "kit", "store"];

const yearKey = (year: string) => `nl:transparency:${year}`;
const actedKey = (year: string) => `nl:transparency:acted:${year}`;
const SINCE = "nl:transparency:since";
/** Each year's counts are kept long after it ends: the page shows past years. */
const KEEP_SECONDS = 6 * 366 * 86_400;
const REPORT_ID = /^[0-9a-f]{16}$/;

const yearOf = (ms: number) => new Date(ms).toISOString().slice(0, 4);

/** A notice received. Never throws: the notice is kept and sent whether or not it is counted. */
export async function countNotice(kind: NoticeKind, now = Date.now()): Promise<void> {
  try {
    if (!isRedisConfigured()) return;
    const k = yearKey(yearOf(now));
    await redisPipeline([["HINCRBY", k, `notice:${kind}`, 1], ["EXPIRE", k, KEEP_SECONDS], ["SET", SINCE, new Date(now).toISOString().slice(0, 10), "NX"]]);
  } catch (error) {
    console.error("counting a notice failed", error);
  }
}

/** A step taken on a notice; the notice counts as acted on once, the first time. Never throws. */
export async function countStep(report: { id: string; kind: NoticeKind }, type: StepType, now = Date.now()): Promise<void> {
  try {
    if (!isRedisConfigured() || !REPORT_ID.test(report.id)) return;
    const year = yearOf(now);
    const [first] = await redisPipeline([["SADD", actedKey(year), report.id], ["EXPIRE", actedKey(year), KEEP_SECONDS]]);
    await redisPipeline([
      ["HINCRBY", yearKey(year), `step:${type}`, 1],
      ...(Number(first) === 1 ? [["HINCRBY", yearKey(year), `acted:${report.kind}`, 1]] : []),
      ["EXPIRE", yearKey(year), KEEP_SECONDS],
      ["SET", SINCE, new Date(now).toISOString().slice(0, 10), "NX"],
    ]);
  } catch (error) {
    console.error("counting a takedown step failed", error);
  }
}

export type YearCounts = {
  year: string;
  notices: Record<NoticeKind, number>;
  acted: Record<NoticeKind, number>;
  steps: Record<StepType, number>;
};

/** A year's hash, field by field, only as HGETALL answers it: an even list of names and whole counts. Else null. */
function countsOf(reply: unknown): Map<string, number> | null {
  const flat = stringList(reply);
  if (!flat || flat.length % 2 !== 0) return null;
  const counts = new Map<string, number>();
  for (let i = 0; i < flat.length; i += 2) {
    const value = flat[i + 1];
    if (!/^\d{1,15}$/.test(value)) return null;
    counts.set(flat[i], Number(value));
  }
  return counts;
}

/**
 * The day counting began (null before the first count), and each year since, newest first.
 * A reply in any other shape is unknown (CX-123 rule 24): it throws UnknownReplyError, never
 * "nothing counted yet" and never a zero; a field the hash does not have is a count never made.
 */
export async function transparencyCounts(now = Date.now()): Promise<{ since: string | null; years: YearCounts[] }> {
  if (!isRedisConfigured()) return { since: null, years: [] };
  const read = repliesFor(await redisPipeline([["GET", SINCE]]), 1);
  if (!read) throw new UnknownReplyError("the day transparency counting began");
  const [since] = read;
  if (since === null) return { since: null, years: [] };
  if (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new UnknownReplyError("the day transparency counting began");
  const first = Number(since.slice(0, 4));
  const last = Number(yearOf(now));
  const years = Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => String(last - i));
  const raws = years.length ? repliesFor(await redisPipeline(years.map((y) => ["HGETALL", yearKey(y)])), years.length) : [];
  if (!raws) throw new UnknownReplyError("the transparency counts");
  return {
    since,
    years: years.map((year, i) => {
      const counts = countsOf(raws[i]);
      if (!counts) throw new UnknownReplyError(`the transparency counts for ${year}`);
      const get = (field: string) => counts.get(field) ?? 0;
      return {
        year,
        notices: { copyright: get("notice:copyright"), other: get("notice:other") },
        acted: { copyright: get("acted:copyright"), other: get("acted:other") },
        steps: { link: get("step:link"), product: get("step:product"), kit: get("step:kit"), store: get("step:store") },
      };
    }),
  };
}
