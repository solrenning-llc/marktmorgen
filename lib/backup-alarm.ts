/**
 * 273 [BK1] (inbox C1-20261108-1530-C4-34 item 1, C1-20261108-2017-C4-36 item 4): the backup's alarm outside Vercel, a
 * dead-man switch. After each run the route sends one signal to an external monitor: a sign of life only after a clean
 * success, a failure signal (with the step's reason, nothing else) after every run that failed or whose prune or room
 * making did not end well, and nothing at all while the backup is off or a run was not its to make. It is the
 * monitor's silence that raises the alarm: warn after BACKUP_ALARM_WARN_HOURS without a sign of life, critical after
 * BACKUP_ALARM_CRITICAL_HOURS (as lib/backup-run.ts's 48-hour staleness). An alarm inside Vercel would go quiet
 * exactly when Vercel is down, so the clock that rings is the monitor's.
 *
 * Off, twice: the route runs it only after a real run, which is off while BACKUP_COST_REVIEW is null; and no signal is
 * sent without BACKUP_ALARM_PING_URL, an https address of the owner's monitor (with no name or password in it). Which
 * monitor, and its two thresholds, are the owner's to set on the monitor (docs/backup.md); nothing here creates an
 * account. The address follows the common ping convention: the sign of life goes to the address, the failure to the
 * address followed by "/fail". Sending never throws: a monitor that cannot be reached shows as silence, which is what
 * it alarms on.
 */
import { timed } from "@/lib/fetch-timeout";
import type { BackupRunResult } from "@/lib/backup-run";

/** Hours without a sign of life before the monitor warns, and before it calls it critical. */
export const BACKUP_ALARM_WARN_HOURS = 26;
export const BACKUP_ALARM_CRITICAL_HOURS = 48;
const TIMEOUT_MS = 10_000;

export type BackupAlarmSignal = { kind: "alive" } | { kind: "fail"; reason: string };
export type BackupAlarmConfig = { url: string };

/** Results that are no run of the backup's: off, or a call that found the day's run done or one going. */
const SILENT = new Set(["off_review", "off_store", "off_key", "already_ran", "busy"]);

/**
 * The signal one run's result gives: alive only for a verified copy whose prune finished and that did not find the
 * last good copy lost; a failure, with the reason, for every other run; none for a call that was no run.
 */
export function backupAlarmSignal(result: BackupRunResult): BackupAlarmSignal | null {
  if (result.ok) {
    if (result.prune !== "done") return { kind: "fail", reason: result.prune };
    if (result.note === "last_good_copy_lost") return { kind: "fail", reason: result.note };
    return { kind: "alive" };
  }
  // A copy stopped at its deadline (C1-20261109-1525-C4-68 item 3) is no sign of life and no failure yet: the day's
  // next run goes on with it. If it never closes, the monitor's silence is the alarm.
  if (result.reason === "copy_incomplete") return null;
  return SILENT.has(result.reason) ? null : { kind: "fail", reason: result.reason };
}

/**
 * The owner's monitor address; null while it is missing, not https, or carries a name, a password, a fragment or a
 * query, even an empty one. A query is refused (Claude 5's MEDIUM, 9 November 2026): "/fail" added to it would land in
 * the query, and a monitor that reads the path would take the failure for a sign of life; a fragment likewise.
 */
export function backupAlarmConfig(): BackupAlarmConfig | null {
  const raw = (process.env.BACKUP_ALARM_PING_URL ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // An empty query or fragment ("?" or "#" at the end) leaves url.search and url.hash empty, so the href is read too
  // (Claude 6's N3): "/fail" after a "#" would never be sent, and the failure would reach the sign of life's path.
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.href.includes("?") || url.href.includes("#")) return null;
  return { url: url.toString().replace(/\/+$/, "") };
}

/** Sends one signal; "sent" only when the monitor answered 2xx. Never throws, never follows a redirect. */
export async function sendBackupAlarm(signal: BackupAlarmSignal, config: BackupAlarmConfig, send: typeof fetch = fetch): Promise<"sent" | "failed"> {
  const target = signal.kind === "alive" ? config.url : `${config.url}/fail`;
  try {
    const status = await timed(TIMEOUT_MS, async (abort) => {
      const response = await send(target, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: signal.kind === "fail" ? signal.reason : "",
        signal: abort,
        cache: "no-store",
        redirect: "error",
      });
      await response.body?.cancel().catch(() => {});
      return response.status;
    });
    return status >= 200 && status < 300 ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
