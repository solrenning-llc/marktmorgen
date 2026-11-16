/**
 * The reminders job says when the payment-request pass failed (#4278, Codex U through Claude 1): a rejected
 * sendDueReminders was turned into `{ sent: 0, skipped: 0 }`, which reads exactly like "nothing was due", so reminders
 * that kept failing never showed in the job's answer. It now answers `requests: null` and `requestsFailed: true`, the
 * convention the courses job uses for its pictures. Every pass is a stand-in (tests/cron-reminders-requests-world.ts);
 * the lock is the in-memory Redis. Synthetic only.
 */
import { GET } from "@/app/api/cron/reminders/route";
import { world } from "./cron-reminders-requests-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const request = () => new Request("https://marktmorgen.com/api/cron/reminders") as unknown as Parameters<typeof GET>[0];
type Answer = { ok: boolean; requests?: { sent: number; skipped: number } | null; requestsFailed?: boolean };
async function run(fail: boolean) {
  redis.clear();
  world.requestsThrow = fail;
  const response = await GET(request());
  return { status: response.status, body: (await response.json()) as Answer };
}

async function main() {
  part("Control: nothing was due");
  const quiet = await run(false);
  is("the counts, no failure said", [quiet.status, quiet.body.requests, quiet.body.requestsFailed ?? false], [200, { sent: 0, skipped: 0 }, false]);

  part("#4278: the payment-request pass threw");
  const failed = await run(true);
  is("never a made-up { sent: 0, skipped: 0 }: requests is null", failed.body.requests, null);
  is("and the failure is said", failed.body.requestsFailed, true);
  done();
}
main();
