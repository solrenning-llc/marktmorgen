/**
 * Issue #4091 (Codex U, scheduled jobs; Claude 6 block of the coordinator's split, 5437): the imports job caught a
 * failed Meta read, welcome reminder pass or scheduled-code switch, logged it, made its field null and answered
 * `ok: true` with HTTP 200, so a scheduled discount left off or a welcome reminder unsent looked like a healthy run.
 * Now each pass that threw is named in `failedPasses` and the run answers `ok: false` with 500; the passes stay apart,
 * so the later ones still run. Every pass is a stand-in (tests/imports-cron-failed-passes-world.ts). Synthetic only.
 */
import { GET } from "@/app/api/cron/imports/route";
import { world } from "./imports-cron-failed-passes-world";
import { done, is, part } from "./check";

const request = () => new Request("https://marktmorgen.com/api/cron/imports") as unknown as Parameters<typeof GET>[0];

async function run(throwing: string[]) {
  world.throwing = new Set(throwing);
  world.ran = [];
  const errors = console.error;
  console.error = () => {};
  const response = await GET(request());
  console.error = errors;
  const body = (await response.json()) as { ok: boolean; failedPasses?: string[] };
  return { status: response.status, ok: body.ok, failed: body.failedPasses ?? [], ran: [...world.ran] };
}

async function main() {
  part("Control: every pass ran");
  is("ok, 200, nothing named", await run([]).then((r) => [r.ok, r.status, r.failed]), [true, 200, []]);

  part("#4091: a pass that threw fails the run and is named; the later passes still run");
  for (const name of ["readMetaDue", "sendWelcomeReminders", "activateScheduledCodes"]) {
    const r = await run([name]);
    is(`${name} threw: not ok, 500, named`, [r.ok, r.status, r.failed], [false, 500, [name]]);
    is(`${name} threw: the move reminders still ran`, r.ran.includes("sendMoveReminders"), true);
  }
  is("all three threw: all three named", await run(["readMetaDue", "sendWelcomeReminders", "activateScheduledCodes"]).then((r) => [r.ok, r.status, r.failed]), [false, 500, ["readMetaDue", "sendWelcomeReminders", "activateScheduledCodes"]]);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
