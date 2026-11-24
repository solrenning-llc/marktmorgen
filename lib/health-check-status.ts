/**
 * The names of the checks that failed in a daily health check's run (app/api/cron/mail-check and stripe-check), said
 * beside the run's error status (issue #4147). An empty list is never sent: a run with no check at all is not "ok"
 * either, and is named as such.
 */
export function failedNames(checks: readonly { check: string; ok: boolean }[]): string[] {
  const failed = checks.filter((c) => !c.ok).map((c) => c.check);
  return failed.length > 0 ? failed : ["no check ran"];
}
