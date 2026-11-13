// Codex E2's proof on #2545 (codex/e2-review-2545-status-boundary-red@1b3b8506), kept as a permanent test with credit.
// Coordinator decision C4-20261106-1520 (rule 23): after the shared hourly ceiling, a cold instance may spend only
// the counter it needs to learn the ceiling was reached (STATUS_COUNT_COMMANDS, as every site limit does in
// lib/request-guard.ts), never a paid history read. The original "0 commands" expectation is replaced by that bound.
/** Reviewer proof for PR #2545: partial Redis replies are not absence. */
import {
  STATUS_CHECKS,
  STATUS_COUNT_COMMANDS,
  STATUS_VIEWS_PER_HOUR,
  forgetStatusMemory,
  readStatus,
  statusViewKey,
} from "@/lib/status-page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 5, 15, 0, 0);
const oldPipeline = redis.pipeline;
const run = (ok: boolean) => JSON.stringify({ at: NOW - 1_000, ok });

async function readWith(
  alter: (batch: (string | number)[][], answers: unknown[]) => unknown[],
) {
  redis.clear();
  redis.run(["LPUSH", STATUS_CHECKS[0].key, run(true)]);
  redis.run(["LPUSH", STATUS_CHECKS[1].key, run(false)]);
  forgetStatusMemory();
  redis.pipeline = async (batch) => {
    const answers = await oldPipeline.call(redis, batch);
    return alter(batch, answers);
  };
  try {
    return await readStatus({ now: NOW, address: "192.0.2.44" });
  } finally {
    redis.pipeline = oldPipeline;
  }
}

async function main() {
  part("Complete replies remain usable");
  let reading = await readWith((_batch, answers) => answers);
  is("control: both histories are known", [reading.database, reading.checks.map((check) => check.summary.state)], ["answered", ["passed", "failed"]]);

  part("A partial or extra counter reply is unknown, not paid room");
  reading = await readWith((batch, answers) => batch[0]?.[0] === "INCR" ? answers.slice(0, 1) : answers);
  is("missing EXPIRE acknowledgement refuses the reading", reading.database, "no-answer");
  reading = await readWith((batch, answers) => batch[0]?.[0] === "INCR" ? [...answers, 1] : answers);
  is("extra counter field refuses the reading", reading.database, "no-answer");

  part("A partial histories reply is unknown, never an empty history");
  reading = await readWith((batch, answers) => batch[0]?.[0] === "LRANGE" ? answers.slice(0, 1) : answers);
  is("missing checkout history refuses the whole reading", [reading.database, reading.checks.map((check) => check.summary.runs)], ["no-answer", [0, 0]]);

  part("The paid global ceiling is checked before another paid command");
  redis.clear();
  const hourKey = statusViewKey(NOW);
  redis.run(["SET", hourKey, String(STATUS_VIEWS_PER_HOUR)]);
  let paidCommands = 0;
  let historyReads = 0;
  redis.pipeline = async (batch) => {
    paidCommands += batch.length;
    historyReads += batch.filter((command) => command[0] === "LRANGE").length;
    return oldPipeline.call(redis, batch);
  };
  try {
    // A cold function instance has empty process memory. Resetting the module
    // state before every request models fifty such instances after the shared
    // hourly read ceiling is already full.
    for (let i = 0; i < 50; i += 1) {
      forgetStatusMemory();
      await readStatus({ now: NOW, address: `203.0.113.${i}:443` });
    }
  } finally {
    redis.pipeline = oldPipeline;
  }
  is("cold instances spend only the counter after the shared ceiling", paidCommands <= 50 * STATUS_COUNT_COMMANDS, true);
  is("no history is read after the shared ceiling", historyReads, 0);
  is("the counter is the real count of visits", redis.run(["GET", hourKey]), String(STATUS_VIEWS_PER_HOUR + 50));
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
