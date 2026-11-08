import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { BACKUP_COST_REVIEW, runBackup } from "@/lib/backup-run";
import { backupAlarmConfig, backupAlarmSignal, sendBackupAlarm } from "@/lib/backup-alarm";

/**
 * 273 [BK1] (inbox C1-20261108-1353-C4-33 item 1, C1-20261108-2017-C4-36 item 4): the daily backup run on Vercel.
 * Scheduled twice a day in vercel.json, the day's run and its new try hours later (BACKUP_RUNS_PER_DAY is 2; the run
 * refuses a third call itself). The run's own cutoff (BACKUP_RUN_CUTOFF_MS, 700 s) ends its writes well before this
 * function's 800 s.
 *
 * Off: while BACKUP_COST_REVIEW is null (the owner's reviewed cost ceiling), it answers "off_review" before a single
 * database command, bucket request or alarm is sent. Only Vercel's cron, with CRON_SECRET, may call it
 * (lib/request-guard.ts); without the secret in production, nothing runs. After a real run, one signal goes to the
 * external dead-man monitor (lib/backup-alarm.ts), itself off without the owner's monitor address.
 */
export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  if (!(await cronAllowed(request))) return new Response("Unauthorized", { status: 401, headers });
  // Checked here too, before anything else: nothing at all is sent while there is no reviewed cost ceiling.
  if (BACKUP_COST_REVIEW === null) return Response.json({ ok: false, reason: "off_review" }, { headers });
  const result = await runBackup();
  const signal = backupAlarmSignal(result);
  const config = backupAlarmConfig();
  const alarm = signal && config ? await sendBackupAlarm(signal, config) : "off";
  if (!result.ok) console.error(`backup: ${result.reason}`);
  // The outcome only: counts and reasons, never a key, an address or a value.
  return Response.json({ ...result, alarm }, { headers });
}
