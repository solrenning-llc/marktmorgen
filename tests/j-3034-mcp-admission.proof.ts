/** Independent sibling of P's marks admission finding; get_emails, not readMarks.
 * Initial API admission uses the real allowance counter. Auth/key parsing is outside
 * this proof. Records and monthly use are synthetic fixtures; no provider IO.
 */
import { emailsTool } from "@/lib/mcp-tools";
import { holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { takeAllowance, allowanceUsed } from "@/lib/store-allowance";
import { API_UNIT_COMMANDS } from "@/lib/api-read-rules";
import { MemoryRedis } from "../lib/redis-memory";
import { SMALL, idsFor, makeStore, redis, writeEmails, type Command } from "./broadcasts-read-cost-world";

const originalRun = MemoryRedis.prototype.run;
let commands = 0;
MemoryRedis.prototype.run = function(command) {
  if (++commands > 10_000) throw new Error("REVIEW_COMMAND_BUDGET");
  return originalRun.call(this, command);
};
const results: { name: string; pass: boolean; actual: unknown; expected: unknown }[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  results.push({ name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
}

async function scenario(count: number, last: boolean) {
  redis.clear();
  const store = await makeStore("mcp-admission@example.com", "mcproberead");
  await writeEmails(store, idsFor(count), () => SMALL);
  // A legitimate pro store with1999 of2000 API calls previously used; no altered quota or counter reply.
  if (last) check("previous monthly use is admitted", (await takeAllowance(store, "api", 1999)).ok, true);
  check(`${count}/${last}: the caller's initial single API unit is really taken`, (await takeAllowance(store, "api", 1)).ok, true);
  const usedBefore = await allowanceUsed(store, "api");
  const pipeline = redis.pipeline.bind(redis);
  let beforeHold = true, measured = 0, allObserved = 0, holdCalls = 0, asked = 0;
  redis.pipeline = async (batch: Command[]) => {
    for (const c of batch) {
      const heads = c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:broadcast-heads:");
      const billed = 1 + (heads ? Number(c[2]) : 0);
      allObserved += billed;
      if (beforeHold && heads) measured += billed;
    }
    return pipeline(batch);
  };
  let result: unknown;
  try {
    result = await emailsTool(store, {
      charge: (more, taken) => takeMoreApi(store, more, taken),
      hold: async most => {
        beforeHold = false;
        holdCalls += 1;
        asked = most;
        return holdMoreApi(store, most);
      },
    });
  } finally { redis.pipeline = pipeline; }
  const usedAfter = await allowanceUsed(store, "api");
  // Only the measuring script, deliberately excluding LRANGE/parallel probes and ALL other work.
  // Even allowing27 commands for a20-command unit is generous to the implementation.
  const generous = API_UNIT_COMMANDS + 7;
  check(`${count}/${last}: measuring alone fits the generous initial API budget`, measured <= generous, true);
  check(`${count}/${last}: one actual hold attempted`, holdCalls, 1);
  check(`${count}/${last}: reader outcome`, result instanceof Response ? result.status : "data", last ? 429 : "data");
  console.log("J_MCP_RECEIPT", JSON.stringify({ count, last, measured, generous, allObserved, holdCalls, asked, usedBefore, usedAfter, status: result instanceof Response ? result.status : "data" }));
}

async function main() {
  await scenario(1, false);
  await scenario(30, false);
  await scenario(30, true);
  const failed = results.filter(x => !x.pass);
  console.log(JSON.stringify({ checks: results.length, pass: results.length-failed.length, fail: failed.length, countedMemoryCommands: commands, failed }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 2; });
