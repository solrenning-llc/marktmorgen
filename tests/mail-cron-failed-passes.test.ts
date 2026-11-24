/**
 * Issue #4090 (Codex U, scheduled jobs; Claude 6 block of the coordinator's split, 5437): the five-minute mail job
 * caught every pass that threw, logged it, and answered `ok: true` with HTTP 200, so a run that left a queue undone
 * (checkouts, sequence steps, saved order mail, webhooks, email platforms) looked healthy to anything reading the
 * status; a rejected count was the factual-looking zero. Now every pass that threw is named in `failedPasses`, the
 * run answers `ok: false` with 500, and a count not read is null; the passes stay apart, so the later ones still run.
 * Every pass is a stand-in (tests/mail-cron-failed-passes-world.ts, through this file's aliases). Synthetic only.
 */
import { GET } from "@/app/api/cron/mail/route";
import { world } from "./mail-cron-failed-passes-world";
import { done, is, part } from "./check";

const request = () => new Request("https://marktmorgen.com/api/cron/mail") as unknown as Parameters<typeof GET>[0];
const ALL = ["runShipmentMail", "runOrderConfirmationMail", "sweepCheckouts", "sendAsked", "sendAssistReminders", "settlePendingOffers", "advanceAll", "sendDueSteps", "advanceAnnouncements", "advanceUpdates", "runLaunches", "runPreorderReleases", "runRestocks", "runLowStockChecks", "sendCallReminders", "runEventQueue", "sendReviewRequests", "watchStripe", "replayKept", "deliverDue", "syncMeetings", "syncDue"];

async function run(throwing: string[], sender = true) {
  world.throwing = new Set(throwing);
  world.sender = sender;
  world.ran = [];
  const errors = console.error;
  console.error = () => {};
  const response = await GET(request());
  console.error = errors;
  const body = (await response.json()) as Record<string, unknown> & { ok: boolean; failedPasses?: string[] };
  return { status: response.status, ok: body.ok, failed: body.failedPasses ?? [], body, ran: [...world.ran] };
}

async function main() {
  part("Control: every pass ran");
  const fine = await run([]);
  is("ok, 200, nothing named", [fine.ok, fine.status, fine.failed], [true, 200, []]);
  is("every pass ran", [...new Set(fine.ran)].sort(), [...ALL].sort());

  part("#4090: any pass that threw fails the run and is named; the later passes still run");
  for (const name of ALL) {
    const r = await run([name]);
    is(`${name} threw: not ok, 500, named`, [r.ok, r.status, r.failed], [false, 500, [name]]);
    is(`${name} threw: the passes after it still ran`, ALL.every((other) => r.ran.includes(other)), true);
  }

  part("A count that was not read is null, never the factual zero");
  const counts = await run(["advanceAll", "sendDueSteps", "runRestocks"]);
  is("broadcasts, sequence steps and restocks are null", [counts.body.broadcasts, counts.body.sent, counts.body.dropped, counts.body.later, counts.body.restocks], [null, null, null, null, null]);
  is("the counts read are kept", [counts.body.announcements, counts.body.updates], [1, 1]);

  part("Without an email sender: the passes that still run fail the run the same way");
  const quiet = await run([], false);
  is("control: ok, 200", [quiet.ok, quiet.status, quiet.failed], [true, 200, []]);
  for (const name of ["sweepCheckouts", "runEventQueue", "deliverDue", "syncDue"]) {
    const r = await run([name], false);
    is(`no sender, ${name} threw: not ok, 500, named`, [r.ok, r.status, r.failed], [false, 500, [name]]);
  }
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
