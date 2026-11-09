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

/** No count was written before this day, so an earlier start day is not one we wrote. */
const FIRST_DAY = "2026-01-01";
/** Every field a year's hash can hold; any other is not one we wrote. */
const FIELDS: ReadonlySet<string> = new Set([
  ...NOTICE_KINDS.flatMap((kind) => [`notice:${kind}`, `acted:${kind}`]),
  ...STEP_TYPES.map((type) => `step:${type}`),
]);

/** A real calendar day, written as we write it (YYYY-MM-DD). */
function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * The years whose counts are certainly still kept on the day `now`: a year's
 * hash lives KEEP_SECONDS after its last count, so at least KEEP_SECONDS after
 * the year began. An older year's hash may be gone, and gone is not zero.
 */
const keptOn = (year: number, now: number) => Date.UTC(year, 0, 1) + KEEP_SECONDS * 1000 > now;

/**
 * The day counting began (null before the first count), and each year since
 * whose counts are still kept, newest first.
 */
export async function transparencyCounts(now = Date.now()): Promise<{ since: string | null; years: YearCounts[] }> {
  if (!isRedisConfigured()) return { since: null, years: [] };
  // Only a start day that is not there is "nothing counted yet"; any other reply is unknown and throws (rule 24).
  const [since] = repliesFor(await redisPipeline([["GET", SINCE]]), 1) ?? unknown("the day counting began");
  if (since === null) return { since: null, years: [] };
  // A start day we could have written: a real day, not before counting could begin, not after today.
  const today = new Date(now).toISOString().slice(0, 10);
  if (typeof since !== "string" || !isDay(since) || since < FIRST_DAY || since > today) unknown("the day counting began");
  const first = Number(since.slice(0, 4));
  const last = Number(yearOf(now));
  const years = Array.from({ length: last - first + 1 }, (_, i) => last - i).filter((year) => keptOn(year, now)).map(String);
  const raws = repliesFor(await redisPipeline(years.map((y) => ["HGETALL", yearKey(y)])), years.length) ?? unknown("a year's counts");
  return {
    since,
    years: years.map((year, i) => {
      // An empty list is a year with nothing counted yet; anything but pairs of text, each a field we write once
      // with a whole number, is unknown.
      const flat = stringList(raws[i]);
      if (!flat || flat.length % 2 !== 0) unknown("a year's counts");
      const counts = new Map<string, number>();
      for (let k = 0; k < flat.length; k += 2) {
        const value = /^\d{1,15}$/.test(flat[k + 1]) ? Number(flat[k + 1]) : null;
        if (value === null || !FIELDS.has(flat[k]) || counts.has(flat[k])) unknown("a year's counts");
        counts.set(flat[k], value);
      }
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

function unknown(what: string): never {
  throw new UnknownReplyError(what);
}
