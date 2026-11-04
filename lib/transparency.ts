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

/** The day counting began (null before the first count), and each year since, newest first. */
export async function transparencyCounts(now = Date.now()): Promise<{ since: string | null; years: YearCounts[] }> {
  if (!isRedisConfigured()) return { since: null, years: [] };
  const [since] = await redisPipeline([["GET", SINCE]]);
  if (typeof since !== "string") return { since: null, years: [] };
  const first = Number(since.slice(0, 4));
  const last = Number(yearOf(now));
  const years = Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => String(last - i));
  const raws = await redisPipeline(years.map((y) => ["HGETALL", yearKey(y)]));
  return {
    since,
    years: years.map((year, i) => {
      const flat = Array.isArray(raws[i]) ? (raws[i] as unknown[]).map(String) : [];
      const get = (field: string) => {
        const at = flat.findIndex((v, k) => k % 2 === 0 && v === field);
        return at >= 0 ? Number(flat[at + 1]) || 0 : 0;
      };
      return {
        year,
        notices: { copyright: get("notice:copyright"), other: get("notice:other") },
        acted: { copyright: get("acted:copyright"), other: get("acted:other") },
        steps: { link: get("step:link"), product: get("step:product"), kit: get("step:kit"), store: get("step:store") },
      };
    }),
  };
}
