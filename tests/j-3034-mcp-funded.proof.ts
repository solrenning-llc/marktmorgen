/** Separate protocol-aware return after disposition6710303953; frozen13 unchanged.
 * Real monthly admissions; synthetic records only. Auth/key/HTTP entry outside scope.
 */
import { emailsTool } from "@/lib/mcp-tools";
import { holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { takeAllowance, allowanceUsed } from "@/lib/store-allowance";
import { API_UNIT_COMMANDS } from "@/lib/api-read-rules";
import { SMALL, idsFor, makeStore, redis, writeEmails, type Command } from "./broadcasts-read-cost-world";
const results: { name: string; pass: boolean; actual: unknown; expected: unknown }[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  results.push({ name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
}
async function scenario(count: number, last: boolean) {
  redis.clear();
  const store = await makeStore("mcpfunded@example.com", "mcpfundedread");
  await writeEmails(store, idsFor(count), () => SMALL);
  if (last) check("real prior1999 admitted", (await takeAllowance(store, "api", 1999)).ok, true);
  check(`${count}/${last}: real door1 admitted`, (await takeAllowance(store, "api", 1)).ok, true);
  const usedBefore = await allowanceUsed(store, "api");
  const pipeline = redis.pipeline.bind(redis);
  let charged = 0, reserved = 0, holdCalls = 0, sizingPaid = 0;
  let observed = 0, measured = 0, read = 0, unfundedSizing = 0, peakUncovered = 0;
  const events: unknown[] = [];
  redis.pipeline = async (batch: Command[]) => {
    for (const c of batch) {
      const heads = c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:broadcast-heads:");
      const n = heads ? Number(c[2]) : 0;
      observed += 1 + n;
      if (heads && c[3 + n] === "size") {
        measured += n;
        if (sizingPaid === 0) unfundedSizing += n;
        events.push({ kind: "measure", n, sizingPaid, observed, budget: (1 + charged + reserved) * API_UNIT_COMMANDS });
      } else if (heads) read += n;
      peakUncovered = Math.max(peakUncovered, observed - (1 + charged + reserved) * API_UNIT_COMMANDS);
    }
    return pipeline(batch);
  };
  let result: Awaited<ReturnType<typeof emailsTool>>;
  try {
    result = await emailsTool(store, {
      charge: async (more, taken) => {
        const refused = await takeMoreApi(store, more, taken);
        if (!refused) { charged += more; if (holdCalls === 0) sizingPaid += more; }
        events.push({ kind: "charge", more, taken, ok: refused === null });
        return refused;
      },
      hold: async (most) => {
        holdCalls += 1;
        const settle = await holdMoreApi(store, most);
        if (settle instanceof Response) return settle;
        reserved += most;
        events.push({ kind: "hold", most });
        return async (actual) => {
          const refused = await settle(actual);
          if (!refused) reserved += actual - most;
          events.push({ kind: "settle", actual, ok: refused === null });
          return refused;
        };
      },
    });
  } finally { redis.pipeline = pipeline; }
  const usedAfter = await allowanceUsed(store, "api");
  check(`${count}/${last}: no sizing without successful real precharge`, unfundedSizing, 0);
  check(`${count}/${last}: every observed prefix covered at strict20 commands/unit`, Math.max(0, peakUncovered), 0);
  check(`${count}/${last}: sizing itself fits only its paid units`, 1 + measured <= sizingPaid * API_UNIT_COMMANDS || measured === 0, true);
  check(`${count}/${last}: actual size/read count`, [measured, read], last ? [0, 0] : [count, count]);
  check(`${count}/${last}: hold follows accepted sizing only`, holdCalls, last ? 0 : 1);
  check(`${count}/${last}: reader outcome`, result instanceof Response ? result.status : result.emails?.length, last ? 429 : count);
  check(`${count}/${last}: actual allowance reconciles with successful charges and settled hold`, usedAfter - usedBefore, charged + reserved);
  if (last) check("refused sizing leaves actual monthly2000 unchanged", [usedBefore, usedAfter, sizingPaid], [2000, 2000, 0]);
  console.log("J_FUNDED_RECEIPT", JSON.stringify({ count, last, measured, read, observed, sizingPaid, charged, reserved, holdCalls, peakUncovered, usedBefore, usedAfter, events }));
}
async function main() {
  await scenario(1, false); await scenario(30, false); await scenario(30, true);
  const failed = results.filter(x => !x.pass);
  console.log(JSON.stringify({ checks: results.length, pass: results.length - failed.length, fail: failed.length, failed }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 2; });
