/** Separate protocol-aware return: refused sizing performs no campaign IO; frozen original stays unchanged. */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET } from "@/app/api/store/stats/range/route";
import { countStudio } from "@/lib/studio-route";
import { idsFor, leaveStudio, makeStore, pipeline, redis, SMALL, writeEmails, type Command } from "./broadcasts-read-cost-world";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  for (const [number, left] of [[1, 5_000], [50, 5_000], [50, 1]]) {
    redis.clear();
    const store = await makeStore("pmarks@example.com", "pmarks");
    const cookie = `${SESSION_COOKIE}=${await openSession("pmarks@example.com")}`;
    await writeEmails(store, idsFor(number), () => SMALL);
    await countStudio(store, null, 1);
    await leaveStudio(left, 5_000);
    const date = new Date().toISOString().slice(0, 10);
    let dispatched = 0;
    let admitted = 1; // Generously credit the route's own request from the start, including authentication.
    let firstTake = true;
    let billed = 0;
    let probe = 0;
    let peakUncovered = 0;
    let beforeExtraProbe = 0;
    let campaignCalls = 0;
    const takes: number[] = [];
    // Use only the actual 20-command unit; do not borrow generous overhead for the coverage assertion.
    const perUnit = 20;
    redis.pipeline = (async (batch: Command[]) => {
      const debit = batch.reduce((n, command) => n + (command[0] === "EVAL" ? 500 : 1), 0);
      if (dispatched + debit > 10_000) throw new Error("Independent review dispatch ceiling exceeded");
      dispatched += debit;
      const take = batch.findIndex((command) => command[0] === "INCRBY" && String(command[1]).startsWith("nl:allow:studio:"));
      const sizing = batch.find((command) => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:broadcast-heads:v") && command[3 + Number(command[2])] === "size");
      const records = batch.filter((command) => (command[0] === "GET" || command[0] === "GETRANGE") && /^nl:mail:bc:[0-9a-f]{24}$/.test(String(command[1]))).length;
      const commands = batch.reduce((n, command) => n + 1 + (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:broadcast-heads:v") ? Number(command[2]) : 0), 0);
      const result = await pipeline(batch);
      billed += commands;
      campaignCalls += records + (sizing ? Number(sizing[2]) : 0);
      if (takes.length <= 1) beforeExtraProbe += records;
      if (sizing) {
        probe += 1 + Number(sizing[2]);
        if (takes.length <= 1) beforeExtraProbe += 1 + Number(sizing[2]);
      }
      if (take >= 0) {
        const units = Number(batch[take][2]);
        const confirmed = typeof result[take] === "number" && Number(result[take]) <= 5_000;
        if (confirmed) {
          takes.push(units);
          if (firstTake) firstTake = false;
          else admitted += units;
        }
      }
      peakUncovered = Math.max(peakUncovered, billed - admitted * perUnit);
      return result;
    }) as typeof redis.pipeline;
    let response: Response;
    try {
      response = await GET(new NextRequest(`https://marktmorgen.com/api/store/stats/range?from=${date}&to=${date}`, { headers: { cookie } }));
    } finally {
      redis.pipeline = pipeline as typeof redis.pipeline;
    }
    const body = await response.json();
    part(`${number} campaigns, ${left} units left`);
    console.log(JSON.stringify({ status: response.status, marks: body.marks?.filter((mark: { kind: string }) => mark.kind === "email").length, takes, billed, probe, beforeExtraProbe, perUnit, peakUncovered }));
    is("the authenticated range route succeeds", response.status, 200);
    is("healthy campaign reads execute; refused admission executes none", left === 1 ? campaignCalls === 0 : campaignCalls >= number, true);
    is("every observed prefix stays inside admitted commands", peakUncovered <= 0, true);
    is("campaign work before additional admission fits the route's own unit", beforeExtraProbe <= perUnit, true);
    if (left === 1) {
      is("no additional work was admitted", takes, [1]);
      is("unfunded campaign marks are omitted", body.marks.filter((mark: { kind: string }) => mark.kind === "email").length, 0);
    }
  }
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
