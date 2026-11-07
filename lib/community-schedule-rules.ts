/**
 * 293 [SQ4]: posts and announcements the creator writes ahead and the
 * community gets at a chosen date and time. The rules, with no reading or
 * writing: what the studio may send, what a scheduled post is kept as, and
 * how its state is said. lib/community-schedule.ts does the keeping and the
 * posting.
 *
 * A scheduled post has words only. A picture is checked and moved when it is
 * posted (lib/community-files.ts) and a poll's days start when it is written,
 * so both stay with posting now.
 */
import { isTimeZone, zonedToUtc } from "@/lib/call-setup";
import { ITEM_ID, MAX_LINKS_IN_POST, MAX_POST_TEXT, MAX_POST_TITLE, cleanLine, cleanText, linkCount } from "@/lib/community-text";
import { dataBytes } from "@/lib/store-data-rules";

/** How many a community keeps waiting, posted or failed at once. */
export const MAX_SCHEDULED_POSTS = 20;
/** The soonest a post can be set for: two runs of the five-minute job, so the time is kept. */
export const MIN_LEAD_SECONDS = 600;
/** The furthest ahead. */
export const MAX_AHEAD_DAYS = 90;
/**
 * How many times the job tries to post one. A try that fails before anything
 * is written (the store or the community could not be read) is tried again
 * one run later; a try whose write may have landed is never made again.
 */
export const PUBLISH_TRIES = 2;
/** How long a try put off waits. */
export const RETRY_SECONDS = 300;
/**
 * The creator's studio requests one scheduled post takes, all when it is
 * scheduled: the act itself, and each try the job may make, which reads the
 * store and writes the post as posting it now does (tests/plan-cost-registry.ts).
 */
export const SCHEDULE_UNITS = 1 + PUBLISH_TRIES;
/** Past its time by this much and still not taken by the job: held up, and the creator may clear it. */
export const STUCK_SECONDS = 900;
/** How long a posted one stays in the studio's list. */
export const POSTED_KEEP_SECONDS = 7 * 86_400;
/** How many the job takes in one run, across all stores. */
export const RUN_BATCH = 25;

export type ScheduleState = "waiting" | "publishing" | "posted" | "failed" | "unknown";
/** What happened to an announcement's email: asked for, not on this plan, nobody asked for email, or an error. */
export type MailOutcome = "" | "queued" | "plan" | "empty" | "error";
/** Why one was not posted. */
export type FailReason = "" | "gone" | "space" | "full" | "room" | "store" | "error";

export type ScheduleInput = {
  /** The space it goes in. */
  sp: string;
  title: string;
  text: string;
  kind: "post" | "announcement";
  /** Email it to the members who asked, when it goes up (announcements only). */
  email: boolean;
  /** When it goes up, in seconds. */
  due: number;
  /** The time zone the creator chose, and the clock they typed, for the form. */
  tz: string;
  date: string;
  time: string;
};

export type ScheduledPost = ScheduleInput & {
  id: string;
  /** When it was scheduled, in seconds. */
  made: number;
  state: ScheduleState;
  /** Tries the job has made. */
  tries: number;
  /** The post it became, once posted. */
  post: string;
  mail: MailOutcome;
  why: FailReason;
  /** When its state last changed, in seconds. */
  at: number;
};

export type ScheduleProblem = "space" | "empty" | "links" | "when" | "no_such_time" | "soon" | "far";

export const SCHEDULE_PROBLEMS: Readonly<Record<ScheduleProblem, string>> = {
  space: "That space is not in your community anymore. Pick another one.",
  empty: "Write something to post. A scheduled post has words only.",
  links: `A post can have at most ${MAX_LINKS_IN_POST} links.`,
  when: "Pick a date, a time and a time zone.",
  no_such_time: "That time does not happen on that day, because the clocks move forward. Pick another time.",
  soon: `Pick a time at least ${MIN_LEAD_SECONDS / 60} minutes from now. To post sooner, post it now from the community page.`,
  far: `Pick a time within ${MAX_AHEAD_DAYS} days.`,
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

/**
 * What the studio sent, checked and cleaned: words as a post now is cleaned
 * (lib/community-text.ts), and a date and a time read on the clock of the
 * zone chosen, so 9 AM in New York is 9 AM there, summer or winter. `now` in
 * milliseconds.
 */
export function readScheduleInput(
  body: Record<string, unknown>,
  spaces: readonly { id: string }[],
  now: number,
): { ok: true; input: ScheduleInput } | { ok: false; problem: ScheduleProblem } {
  const sp = typeof body.space === "string" && ITEM_ID.test(body.space) ? body.space : "";
  if (!sp || !spaces.some((s) => s.id === sp)) return { ok: false, problem: "space" };
  const title = cleanLine(body.title, MAX_POST_TITLE);
  const text = cleanText(body.text, MAX_POST_TEXT);
  if (!text) return { ok: false, problem: "empty" };
  if (linkCount(`${title}\n${text}`) > MAX_LINKS_IN_POST) return { ok: false, problem: "links" };
  const kind = body.kind === "announcement" ? "announcement" : "post";
  const tz = typeof body.tz === "string" && isTimeZone(body.tz) ? body.tz : "";
  const date = DATE.exec(typeof body.date === "string" ? body.date : "");
  const time = TIME.exec(typeof body.time === "string" ? body.time : "");
  if (!tz || !date || !time) return { ok: false, problem: "when" };
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  if (hour > 23 || minute > 59 || month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, problem: "when" };
  const ms = zonedToUtc(Number(date[1]), month, day, hour * 60 + minute, tz);
  if (ms === null) return { ok: false, problem: "no_such_time" };
  const due = Math.floor(ms / 1000);
  const nowSeconds = Math.floor(now / 1000);
  if (due < nowSeconds + MIN_LEAD_SECONDS) return { ok: false, problem: "soon" };
  if (due > nowSeconds + MAX_AHEAD_DAYS * 86_400) return { ok: false, problem: "far" };
  return {
    ok: true,
    input: { sp, title, text, kind, email: kind === "announcement" && body.email === true, due, tz, date: date[0], time: time[0] },
  };
}

const STATES: readonly ScheduleState[] = ["waiting", "publishing", "posted", "failed", "unknown"];
const MAILS: readonly MailOutcome[] = ["", "queued", "plan", "empty", "error"];
const WHYS: readonly FailReason[] = ["", "gone", "space", "full", "room", "store", "error"];
const seconds = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** A kept record, read strictly: anything else is not one. */
export function parseRecord(raw: unknown): ScheduledPost | null {
  if (typeof raw !== "string" || !raw) return null;
  let v: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    v = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const text = (key: string, max: number) => (typeof v[key] === "string" && (v[key] as string).length <= max ? (v[key] as string) : null);
  const id = text("id", 12);
  const sp = text("sp", 12);
  const title = text("title", MAX_POST_TITLE);
  const body = text("text", MAX_POST_TEXT);
  const tz = text("tz", 64);
  const date = text("date", 10);
  const time = text("time", 5);
  const post = text("post", 12);
  if (!id || !ITEM_ID.test(id) || !sp || !ITEM_ID.test(sp) || title === null || !body || !tz || date === null || time === null || post === null) return null;
  if (post && !ITEM_ID.test(post)) return null;
  if (v.kind !== "post" && v.kind !== "announcement") return null;
  if (typeof v.email !== "boolean" || !seconds(v.due) || !seconds(v.made) || !seconds(v.at) || !seconds(v.tries)) return null;
  if (!STATES.includes(v.state as ScheduleState) || !MAILS.includes(v.mail as MailOutcome) || !WHYS.includes(v.why as FailReason)) return null;
  return {
    id,
    sp,
    title,
    text: body,
    kind: v.kind,
    email: v.email,
    due: v.due as number,
    tz,
    date,
    time,
    made: v.made as number,
    state: v.state as ScheduleState,
    tries: v.tries as number,
    post,
    mail: v.mail as MailOutcome,
    why: v.why as FailReason,
    at: v.at as number,
  };
}

/**
 * What one takes in the store's data room, from the moment it is scheduled:
 * its record at its largest state (a post id, the longest outcome words) and
 * its places in the community's list and the job's due list.
 */
export function recordBytes(post: ScheduledPost): number {
  const largest: ScheduledPost = { ...post, state: "publishing", post: "0".repeat(12), mail: "queued", why: "store", tries: PUBLISH_TRIES };
  return dataBytes([JSON.stringify(largest), 32 + 12, 32 + 32 + 12 + 2], 3);
}

/** Whether the job will not touch it again: done, or held up well past its time. */
export function settled(post: ScheduledPost, nowSeconds: number): boolean {
  if (post.state === "posted" || post.state === "failed" || post.state === "unknown") return true;
  if (post.state === "waiting") return post.due + STUCK_SECONDS < nowSeconds;
  return post.at + STUCK_SECONDS < nowSeconds;
}

const FAILED: Readonly<Record<FailReason, string>> = {
  "": "It was not posted.",
  gone: "It was not posted: the community is not there anymore.",
  space: "It was not posted: its space was removed. Schedule it again in another space.",
  full: "It was not posted: the community has as many posts as it can keep. Delete some old ones, then schedule it again.",
  room: "It was not posted: your store's data room is full. Make room, then schedule it again.",
  store: "It was not posted: your store is not open right now.",
  error: "It was not posted: we could not reach your store at its time. Schedule it again.",
};

const MAILED: Readonly<Record<MailOutcome, string>> = {
  "": "",
  queued: " Its email is going out to the members who asked for announcements.",
  plan: " It was not emailed: your plan does not send community emails right now.",
  empty: " It was not emailed: nobody has asked for announcement emails yet.",
  error: " Its email could not be started.",
};

/** One sentence on where it stands, for the studio. `nowSeconds` decides when a waiting one counts as held up. */
export function stateWords(post: ScheduledPost, nowSeconds: number): string {
  if (post.state === "posted") return `Posted.${post.email ? MAILED[post.mail] : ""}`;
  if (post.state === "failed") return FAILED[post.why];
  if (post.state === "unknown" || (post.state === "publishing" && settled(post, nowSeconds))) {
    return "We could not confirm it was posted. Look at your community feed, and post it again if it is not there.";
  }
  if (post.state === "publishing") return "Being posted now.";
  if (settled(post, nowSeconds)) return "It is late and has not been posted yet. You can clear it and post it from the community page.";
  return post.tries > 0 ? "Waiting. The first try did not reach your store, so it is tried again in a few minutes." : "Waiting.";
}
