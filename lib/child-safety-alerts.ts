/**
 * The owner's urgent email about a child-safety report or a request to remove
 * an intimate image (lib/child-safety.ts, alertOwner) is repeated every
 * REMIND_HOURS until the owner marks the report handled; for an intimate
 * image a reminder also goes WARN_BEFORE_HOURS before the TAKE IT DOWN Act's
 * 48-hour deadline, naming it in UTC (C1-20261109-1546-TODOS-70; procedure in
 * docs/incident-response.md section 8).
 *
 *   nl:csa:alert:<id>   JSON     one open report: its kind, where, the store's handle, what was done
 *                                when it came in, when it came in and was last emailed, how many
 *                                emails went, the deadline of an intimate image, and the hashes of
 *                                its handled links; ALERT_KEEP_SECONDS
 *   nl:csa:alerts       zset     the open reports' ids by when each is next due; ALERT_KEEP_SECONDS
 *                                from the last report, its members taken out as they end
 *   nl:csa:once:<hash>  string   the id of the alert one request opened, claimed (NX) before it opens:
 *                                a hash of its kind, the request's hash and the UTC day, the same
 *                                identity as the urgent email's idempotency key; ALERT_ONCE_SECONDS
 *
 * A retry of the same request the same day (the same address, sender and
 * words: lib/child-safety.ts, alertOwner) finds the claim and opens nothing:
 * the first alert is kept as it is, with its one reminder series and its
 * links. A claim answered off its shape is unknown: nothing is opened.
 *
 * Never the reporter's words or address, and never a link itself: each email
 * carries its own handled link (32 random bytes after the id), kept only as a
 * hash. Opening the link shows a button; only that button's POST from this
 * site closes the report (app/report/handled, app/api/report/handled), since
 * mail scanners open links.
 *
 * Everything is bounded: a report is reminded for ALERT_DAYS at the most and
 * gets ALERT_SENDS emails at the most, the last saying so; a run sends at most
 * ALERT_BATCH; and at most OPEN_ALERTS_MAX reports are open at once, so the
 * anonymous form cannot grow storage or email without bound: past it the
 * urgent email still goes, and says that no reminder will follow.
 *
 * The sweep (sendDueAlerts) runs in the hourly quiet cron, under its lock. A
 * Redis reply off its shape is unknown: nothing is sent, nothing is dropped,
 * the next run tries again; the sweep never throws.
 */
import { createHash, randomBytes } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { repliesFor, stringList } from "@/lib/redis-reply";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { SITE_URL } from "@/lib/site-url";
import type { HoldOutcome } from "@/lib/child-safety";

/** Hours between reminders of an open report. */
export const REMIND_HOURS = 24;
/** Hours before an intimate image's 48-hour deadline that a reminder names it. */
export const WARN_BEFORE_HOURS = 6;
/** Days a report is reminded at the most. */
export const ALERT_DAYS = 30;
/** Emails one report gets at the most, the urgent one included. */
export const ALERT_SENDS = 30;
/** Reports open at once at the most; past it, the urgent email still goes, with no reminder. */
export const OPEN_ALERTS_MAX = 200;
/** Reminders one run sends at the most. */
export const ALERT_BATCH = 10;
/** How long an open report's record and the due list are kept: its reminding days and a margin. */
export const ALERT_KEEP_SECONDS = (ALERT_DAYS + 2) * 86_400;
/** How long a request's claim is kept: past the end of its UTC day, which is part of its identity. */
export const ALERT_ONCE_SECONDS = 2 * 86_400;

export const ALERTS_DUE = "nl:csa:alerts";
export const alertKey = (id: string) => `nl:csa:alert:${id}`;
/** The claim of one request (its kind, its hash and its UTC day), never the reporter's words or address. */
export const alertOnceKey = (request: string) => `nl:csa:once:${createHash("sha256").update(`csa-alert:${request}`).digest("hex").slice(0, 32)}`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TAKE_IT_DOWN_MS = 48 * HOUR;
const ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[0-9a-f]{96}$/;
const HASH = /^[0-9a-f]{64}$/;
const KINDS = ["child_safety", "intimate_image"] as const;
const OUTCOMES: readonly HoldOutcome[] = ["held", "files_unconfirmed", "no_product", "not_held", "capped", "unknown", "failed"];

type Kind = (typeof KINDS)[number];
type Alert = {
  v: 1;
  kind: Kind;
  url: string;
  handle: string;
  outcome: HoldOutcome;
  firstAt: number;
  lastSentAt: number;
  sends: number;
  deadline: number;
  warned: boolean;
  tokens: string[];
};

const hashOf = (token: string) => createHash("sha256").update(`csa-handled:${token}`).digest("hex");
export const handledUrl = (token: string) => `${SITE_URL}/report/handled/${token}`;

/** Only a Marktmorgen address is kept or shown; anything else is named, not quoted (as alertOwner does). */
function where(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "marktmorgen.com" || host === "www.marktmorgen.com") return url.slice(0, 2_000);
  } catch {
    // not an address: said below
  }
  return "an address outside Marktmorgen (see the notice email)";
}

/** "November 11, 2026, 3:00 PM UTC", spelled out so no locale's spacing changes it. */
export function utcTime(ms: number): string {
  const at = new Date(ms);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const hours = at.getUTCHours();
  const minutes = String(at.getUTCMinutes()).padStart(2, "0");
  return `${months[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}, ${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"} UTC`;
}

const safeTime = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A record exactly as written, or null: anything off its shape is unknown. */
function parse(value: unknown): Alert | null {
  if (typeof value !== "string") return null;
  let data: unknown;
  try {
    data = JSON.parse(value);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const a = data as Record<string, unknown>;
  if (a.v !== 1 || !KINDS.includes(a.kind as Kind) || !OUTCOMES.includes(a.outcome as HoldOutcome)) return null;
  if (typeof a.url !== "string" || a.url.length > 2_100 || typeof a.handle !== "string" || a.handle.length > 64) return null;
  if (!safeTime(a.firstAt) || !safeTime(a.lastSentAt) || !safeTime(a.deadline) || typeof a.warned !== "boolean") return null;
  if (typeof a.sends !== "number" || !Number.isSafeInteger(a.sends) || a.sends < 1 || a.sends > ALERT_SENDS) return null;
  if (!Array.isArray(a.tokens) || a.tokens.length < 1 || a.tokens.length > ALERT_SENDS + 1) return null;
  if (!a.tokens.every((t) => typeof t === "string" && HASH.test(t))) return null;
  return a as unknown as Alert;
}

/** When an open report is next due: a day after its last email, or, for an intimate image, the warning first. */
function nextDue(alert: Alert): number {
  const day = alert.lastSentAt + REMIND_HOURS * HOUR;
  if (alert.kind !== "intimate_image" || alert.warned) return day;
  return Math.min(day, Math.max(alert.deadline - WARN_BEFORE_HOURS * HOUR, alert.lastSentAt + 1));
}

/** A fresh handled link for one email: the id and 32 random bytes; only its hash is kept. */
function newToken(id: string): { token: string; hash: string } {
  const token = `${id}${randomBytes(32).toString("hex")}`;
  return { token, hash: hashOf(token) };
}

/** Takes back an alert this call opened, its claim with it, so a retry of the request may set its reminder up. */
async function forget(id: string, once: string): Promise<void> {
  await redisPipeline([
    ["ZREM", ALERTS_DUE, id],
    ["DEL", alertKey(id)],
    ["DEL", once],
  ]).catch(() => console.error("a child-safety reminder that could not be set up could not be taken back"));
}

/**
 * Sends the owner's urgent email with its reminder opened (lib/child-safety.ts,
 * alertOwner): `send` gets the lines this module adds (the handled link, or
 * why no reminder will follow) and says whether the email went. An urgent
 * email that did not go is reminded within the hour instead of the day.
 * `request` is the request's identity (its kind, hash and UTC day): a retry
 * of it opens nothing and leaves the first alert as it is.
 */
export async function withReminders(
  report: { kind: Kind; url: string; handle: string; outcome: HoldOutcome; request: string },
  now: number,
  send: (lines: string[]) => Promise<boolean>,
): Promise<boolean> {
  const id = randomBytes(16).toString("hex");
  const once = alertOnceKey(report.request);
  const link = newToken(id);
  const alert: Alert = {
    v: 1,
    kind: report.kind,
    url: where(report.url),
    handle: report.handle.slice(0, 64),
    outcome: report.outcome,
    firstAt: now,
    lastSentAt: now,
    sends: 1,
    deadline: report.kind === "intimate_image" ? now + TAKE_IT_DOWN_MS : 0,
    warned: false,
    tokens: [link.hash],
  };
  let state: "open" | "full" | "unknown" | "again" = "unknown";
  let claimed = false;
  try {
    // Claimed before anything is opened (NX): a retry of the same request finds it and opens nothing, and the first
    // alert, its due time and its links are left exactly as they are. A reply off its shape opens nothing (rule 24).
    const claim = repliesFor(await redisPipeline([["SET", once, id, "NX", "EX", ALERT_ONCE_SECONDS]]), 1);
    if (claim?.[0] === null) {
      state = "again";
      console.error("a child-safety report came again the same day: its alert is already open, none added");
    } else if (claim?.[0] !== "OK") console.error("a child-safety report's claim could not be confirmed; no reminder opened");
    else claimed = true;
  } catch (error) {
    console.error("a child-safety report's claim could not be confirmed", error instanceof Error ? error.message : "unknown");
  }
  if (claimed) {
    try {
      const replies = repliesFor(
        await redisPipeline([
          ["SET", alertKey(id), JSON.stringify(alert), "EX", ALERT_KEEP_SECONDS, "NX"],
          ["ZADD", ALERTS_DUE, nextDue(alert), id],
          ["EXPIRE", ALERTS_DUE, ALERT_KEEP_SECONDS],
          ["ZCARD", ALERTS_DUE],
        ]),
        4,
      );
      const count = replies?.[3];
      if (replies?.[0] !== "OK" || replies[1] !== 1 || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) state = "unknown";
      else state = count > OPEN_ALERTS_MAX ? "full" : "open";
    } catch (error) {
      console.error("a child-safety reminder could not be set up", error instanceof Error ? error.message : "unknown");
    }
  }
  if (claimed && state !== "open") await forget(id, once);
  const lines =
    state === "open"
      ? [
          "",
          `A reminder comes every ${REMIND_HOURS} hours until it is marked handled${report.kind === "intimate_image" ? `, and one ${WARN_BEFORE_HOURS} hours before the deadline` : ""}, for up to ${ALERT_DAYS} days.`,
          `When it is dealt with, mark it handled here: ${handledUrl(link.token)}`,
        ]
      : state === "full"
        ? ["", `The reminder list is full (${OPEN_ALERTS_MAX} open reports), so no reminder will come for this one. Act on it now, and mark the reports already dealt with handled from their emails.`]
        : state === "again"
          ? ["", "This report was already received today, so no second reminder is set up for it: act on it from the first email and its reminders."]
          : ["", "Reminders for this report could not be set up just now, so none will come. Act on it now."];
  const sent = await send(lines).catch(() => false);
  if (!sent && state === "open") {
    await redisPipeline([["ZADD", ALERTS_DUE, "XX", now + HOUR, id]]).catch(() => console.error("an unsent urgent email's reminder could not be brought forward"));
  }
  return sent;
}

function reminderText(alert: Alert, n: number, now: number, link: string, last: boolean): { subject: string; text: string } {
  const child = alert.kind === "child_safety";
  const what = child ? "child safety report" : "request to remove an intimate image";
  const about = alert.handle ? ` about @${alert.handle}` : "";
  const done: Record<HoldOutcome, string> = {
    held: "When it came in, the product it points at was taken off the store automatically, and it stays held.",
    files_unconfirmed: "When it came in, the product it points at was taken off the store, but keeping its files could not be confirmed: suspend the store, as docs/incident-response.md section 8 says.",
    no_product: "When it came in, nothing was taken off automatically: act on it by hand, as docs/incident-response.md section 8 says.",
    not_held: "Nothing was taken off automatically: act on it by hand, as docs/incident-response.md section 8 says.",
    capped: "When it came in, nothing was taken off automatically (the store's daily cap was reached): act on it by hand, as docs/incident-response.md section 8 says.",
    unknown: "When it came in, taking it off the store could not be confirmed: act on it by hand, as docs/incident-response.md section 8 says.",
    failed: "When it came in, taking it off the store did not work: act on it by hand, as docs/incident-response.md section 8 says.",
  };
  const deadline = utcTime(alert.deadline);
  const timing = child
    ? []
    : now >= alert.deadline
      ? [`The 48-hour deadline passed on ${deadline}. Remove it now, with any identical copies on the site.`]
      : alert.deadline - now <= WARN_BEFORE_HOURS * HOUR
        ? [`The 48-hour deadline is close: about ${WARN_BEFORE_HOURS} hours are left. Remove it by ${deadline}, with any identical copies on the site.`]
        : [`Remove it by ${deadline} (48 hours from the request), with any identical copies on the site.`];
  const lines = [
    `This ${what} is still open since ${utcTime(alert.firstAt)}: it has not been marked handled.`,
    "",
    `Where: ${alert.url}`,
    ...(child ? [done[alert.outcome]] : timing),
    "",
    child
      ? "Do not open, download, forward or describe the reported content, and do not ask any AI agent to look at it."
      : "Do not forward or describe the image, and do not ask any AI agent to look at it.",
    "The steps are in docs/incident-response.md section 8.",
    "",
    `When it is dealt with, mark it handled here, and the reminders stop: ${link}`,
    ...(last ? ["", `This is the last reminder for this report: reminders stop after ${ALERT_DAYS} days or ${ALERT_SENDS} emails. Act on it now.`] : []),
  ];
  return { subject: `URGENT (reminder ${n}): ${what}${about}, still open since ${utcTime(alert.firstAt)}`.slice(0, 200), text: lines.join("\n") };
}

export type SweepResult = { sent: number; failed: number; unknown: number; ended: number };

/**
 * Sends the reminder of each open report that is due at `now`, at most
 * ALERT_BATCH, and sets its next time; it stops early once the clock passes
 * `until` (a time budget on the real clock). Never throws: what cannot be read
 * is left as it is for the next run.
 */
export async function sendDueAlerts(now: number, until = Date.now() + 20_000): Promise<SweepResult> {
  const out: SweepResult = { sent: 0, failed: 0, unknown: 0, ended: 0 };
  try {
    const listed = repliesFor(await redisPipeline([["ZRANGEBYSCORE", ALERTS_DUE, "-inf", now, "LIMIT", 0, ALERT_BATCH]]), 1);
    const ids = listed ? stringList(listed[0]) : null;
    if (!ids) {
      out.unknown += 1;
      console.error("child-safety reminders: the due list could not be read; nothing sent this run");
      return out;
    }
    for (const id of ids) {
      if (Date.now() > until) break;
      try {
        await remindOne(id, now, out);
      } catch (error) {
        out.unknown += 1;
        console.error("child-safety reminders: one could not be confirmed", error instanceof Error ? error.message : "unknown");
      }
    }
  } catch (error) {
    out.unknown += 1;
    console.error("child-safety reminders: the run could not be confirmed", error instanceof Error ? error.message : "unknown");
  }
  return out;
}

/**
 * A report this run could not read or send is moved an hour on (XX: only while
 * it is still listed), never dropped: the next run tries it again, and the
 * reports behind it in the due list are reached instead of being blocked.
 */
async function postpone(id: string, now: number): Promise<void> {
  await redisPipeline([["ZADD", ALERTS_DUE, "XX", now + HOUR, id]]).catch(() => console.error("child-safety reminders: one that could not be sent could not be moved on"));
}

async function remindOne(id: string, now: number, out: SweepResult): Promise<void> {
  if (!ID.test(id)) {
    out.unknown += 1;
    return;
  }
  const read = repliesFor(await redisPipeline([["GET", alertKey(id)]]), 1);
  if (!read) {
    out.unknown += 1;
    return;
  }
  if (read[0] === null) {
    // Its record ran out or was closed between the list and this read: out of the list.
    await redisPipeline([["ZREM", ALERTS_DUE, id]]);
    out.ended += 1;
    return;
  }
  const alert = parse(read[0]);
  if (!alert) {
    out.unknown += 1;
    await postpone(id, now);
    return;
  }
  const n = alert.sends;
  const warning = alert.kind === "intimate_image" && !alert.warned && now >= alert.deadline - WARN_BEFORE_HOURS * HOUR;
  const after: Alert = { ...alert, lastSentAt: now, sends: alert.sends + 1, warned: alert.warned || warning };
  const last = after.sends >= ALERT_SENDS || nextDue(after) >= alert.firstAt + ALERT_DAYS * DAY;
  const link = newToken(id);
  // The urgent email's link is always kept; the reminders' newest links after it, within the record's bound.
  after.tokens = [alert.tokens[0], ...[...alert.tokens.slice(1), link.hash].slice(-ALERT_SENDS)];
  const keep = Math.max(3_600, Math.ceil((alert.firstAt + ALERT_KEEP_SECONDS * 1000 - now) / 1000));
  // The link's hash is kept before the email goes (XX: only while still open), so the email the owner holds always
  // closes the report: a send said failed that was delivered, or a write-back that was lost, never leaves it dead.
  const stored = repliesFor(await redisPipeline([["SET", alertKey(id), JSON.stringify({ ...alert, tokens: after.tokens }), "EX", keep, "XX"]]), 1);
  if (stored?.[0] === null) {
    // Marked handled, or run out, since it was read: nothing to send, out of the list.
    await redisPipeline([["ZREM", ALERTS_DUE, id]]);
    out.ended += 1;
    return;
  }
  if (stored?.[0] !== "OK") {
    out.unknown += 1;
    await postpone(id, now);
    return;
  }
  const { subject, text } = reminderText(alert, n, now, handledUrl(link.token), last);
  const sent = await sendEmail({
    meter: { by: "company" },
    from: NIMBUS_FROM,
    to: SUPPORT_EMAIL,
    subject,
    text,
    idempotencyKey: `csa-reminder-${id}-${n}`,
  }).catch(() => false);
  if (!sent) {
    // Left due: the next run tries again, under the same key, so it is never sent twice.
    out.failed += 1;
    await postpone(id, now);
    return;
  }
  out.sent += 1;
  if (last) {
    const replies = repliesFor(
      await redisPipeline([
        ["ZREM", ALERTS_DUE, id],
        ["DEL", alertKey(id)],
      ]),
      2,
    );
    if (!replies || typeof replies[0] !== "number" || typeof replies[1] !== "number") out.unknown += 1;
    else out.ended += 1;
    return;
  }
  // Only a report still open is written back (XX): one marked handled in between stays closed.
  const replies = repliesFor(
    await redisPipeline([
      ["SET", alertKey(id), JSON.stringify(after), "EX", keep, "XX"],
      ["ZADD", ALERTS_DUE, "XX", nextDue(after), id],
    ]),
    2,
  );
  if (!replies || (replies[0] !== "OK" && replies[0] !== null) || typeof replies[1] !== "number") out.unknown += 1;
}

/** What the handled page shows of an open report, or null when the link is not one of an open report; throws when unknown. */
export async function readAlert(token: string): Promise<{ kind: Kind; handle: string; firstAt: number } | null> {
  if (!TOKEN.test(token)) return null;
  const read = repliesFor(await redisPipeline([["GET", alertKey(token.slice(0, 32))]]), 1);
  if (!read) throw new Error("A child-safety report could not be read");
  if (read[0] === null) return null;
  const alert = parse(read[0]);
  if (!alert) throw new Error("A child-safety report could not be read");
  if (!alert.tokens.includes(hashOf(token))) return null;
  return { kind: alert.kind, handle: alert.handle, firstAt: alert.firstAt };
}

/**
 * Marks a report handled from one of its links: out of the due list and its
 * record gone, so no reminder follows. "unknown_link" for a link that is not
 * one of an open report; "unknown" when it could not be confirmed.
 */
export async function closeAlert(token: string): Promise<"closed" | "unknown_link" | "unknown"> {
  try {
    if (!(await readAlert(token))) return "unknown_link";
    const id = token.slice(0, 32);
    const replies = repliesFor(
      await redisPipeline([
        ["ZREM", ALERTS_DUE, id],
        ["DEL", alertKey(id)],
      ]),
      2,
    );
    return replies && typeof replies[0] === "number" && typeof replies[1] === "number" ? "closed" : "unknown";
  } catch (error) {
    console.error("a child-safety report could not be marked handled", error instanceof Error ? error.message : "unknown");
    return "unknown";
  }
}
