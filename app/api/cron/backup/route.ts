import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { BACKUP_COST_REVIEW, backupKey, runBackup } from "@/lib/backup-run";
import { backupKeyFingerprint } from "@/lib/backup-codec";
import { backupAlarmConfig, backupAlarmSignal, sendBackupAlarm } from "@/lib/backup-alarm";

/**
 * 273 [BK1] (inbox C1-20261108-1353-C4-33 item 1, C1-20261108-2017-C4-36 item 4): the daily backup run on Vercel.
 * Scheduled twice a day in vercel.json, the day's run and its new try hours later (BACKUP_RUNS_PER_DAY is 2; the run
 * refuses a third call itself). The run's own cutoff (BACKUP_RUN_CUTOFF_MS, 240 s), the four database requests sent
 * outside it (BACKUP_REQUESTS_OUTSIDE_CUTOFF, 5 s each at most) and the alarm (10 s at most) end 30 s before this
 * function's 300 s: 800 s needs Fluid compute, which no deployment accepted (C2-20261113-1415-ADOTAR-5), and a build
 * refusing it on main would stop every publication. A copy the cutoff ends is refused whole (export_cutoff), never kept
 * as a partial one, and the day's new try runs it again.
 *
 * Off: while BACKUP_COST_REVIEW is null (the owner's reviewed cost ceiling), it answers "off_review" before a single
 * database command, bucket request or alarm is sent. Only Vercel's cron, with CRON_SECRET, may call it
 * (lib/request-guard.ts); without the secret in production, nothing runs. After a real run, one signal goes to the
 * external dead-man monitor (lib/backup-alarm.ts), itself off without the owner's monitor address.
 */
export const maxDuration = 300;

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
  // The outcome only: counts, reasons and the key's fingerprint (inbox C4-36 item 2), never a key, an address or a value.
  const key = backupKey();
  return Response.json({ ...result, kid: key ? backupKeyFingerprint(key) : null, alarm }, { headers });
}
