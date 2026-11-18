/**
 * 273 [BK1], files part 2: the entry of the files-and-videos backup Worker,
 * deployed by the owner in the separate backup account once its cost is
 * approved (docs/backup-costs-2026-11-08.md, 5a to 5c). Off until then: no
 * workflow deploys it, and the site's route answers 404 without its own
 * secret and the owner's review (lib/backup-files-review.ts).
 *
 * A scheduled handler only (5a, 7a item 7): no fetch handler, and
 * wrangler.toml sets workers_dev = false and no route, so nothing but its
 * hourly cron can start it and no HTTP request can be billed to it.
 * controller.noRetry() on every outcome: a failed run is never retried at
 * once (Cloudflare does not state how many times it would retry); the next
 * hourly run goes on from the state the last one saved.
 */
import { runBackupFiles, type BackupFilesEnv } from "./run";

type ScheduledController = { readonly scheduledTime: number; readonly cron: string; noRetry(): void };
type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };

const worker: { scheduled(controller: ScheduledController, env: BackupFilesEnv, ctx: ExecutionContext): Promise<void> } = {
  async scheduled(controller, env) {
    controller.noRetry();
    try {
      const report = await runBackupFiles(env, { fetch: (input, init) => fetch(input, init), now: () => Date.now() });
      console.log("backup files:", JSON.stringify({ day: report.day, finished: report.finished, heartbeat: report.heartbeat, alarms: report.alarms.map((a) => a.code), subrequests: report.subrequests, stoppedBy: report.stoppedBy }));
    } catch (error) {
      console.error("backup files: the run failed", error instanceof Error ? error.name : "unknown");
    } finally {
      controller.noRetry();
    }
  },
};

export default worker;
