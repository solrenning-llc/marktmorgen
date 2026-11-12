import { NextRequest } from "next/server";
import { GET as weekly } from "@/app/api/cron/weekly/route";
import { GET as monthly } from "@/app/api/cron/monthly/route";
import { control } from "./numbers-email-claim-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// The weekly and monthly numbers-email crons run every hour for two days (48 runs). Each run started again at the
// first visited folder and read every store already claimed for the period (the store, its stop, its channel and a
// claim that answers "taken") before reaching one not yet claimed, and only claimed stores count towards MAX_PER_RUN.
// So run k read about 25k stores, and every run after the last store was claimed re-read all of them until its time
// ran out. A store decided for the period (sent, quiet, stopped, not on a running plan, already claimed) is kept in
// one set per period, read once a run, so a run with nothing left to do reads no store at all. Synthetic stores,
// stubbed sender and stats (tests/numbers-email-claim-world.ts); no network.

const S = 500;
const real = redis.pipeline.bind(redis);
let commands = 0;
const request = (path: string) => new NextRequest(`https://example.test${path}`);

async function runAll(route: typeof weekly, path: string): Promise<{ runs: number; perRun: number[] }> {
  const perRun: number[] = [];
  for (let run = 0; run < 48; run += 1) {
    const before = commands;
    const body = await (await route(request(path))).json();
    perRun.push(commands - before);
    if (!body.ok) throw new Error(`run ${run} failed: ${JSON.stringify(body)}`);
    if (body.looked === 0) return { runs: run + 1, perRun };
  }
  return { runs: 48, perRun };
}

function claimed(prefix: string): number {
  let n = 0;
  for (let i = 0; i < S; i += 1) if (redis.run(["GET", `${prefix}${control.folders[i]}`]) !== null) n += 1;
  return n;
}

async function main(): Promise<void> {
  globalThis.fetch = async () => { throw new Error("No real network request belongs in a numbers-email route test"); };
  redis.pipeline = async (batch) => {
    commands += batch.length;
    return real(batch);
  };
  control.folders = Array.from({ length: S }, (_, i) => `store${String(i).padStart(4, "0")}`);
  control.numbers = "visitors-0";

  for (const [name, route, path, prefix] of [
    ["Weekly", weekly, "/api/cron/weekly", `nl:weekly:sent:`],
    ["Monthly", monthly, "/api/cron/monthly", `nl:monthly:sent:`],
  ] as const) {
    part(`${name}: ${S} stores with visitors, worked through 25 a run`);
    redis.clear();
    const { runs, perRun } = await runAll(route, path);
    const week = name === "Weekly" ? new Date(Date.now() - ((new Date().getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10) : "";
    const period = name === "Weekly" ? week : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    is("every store is reached and claimed once", claimed(`${prefix}${period}:`), S);
    is("in S / 25 runs, plus the one that finds nothing", runs, S / 25 + 1);
    const tenth = perRun[9] ?? 0;
    is(`the tenth run reads only its own 25 stores, not the 225 claimed before it (it sent ${tenth} commands)`, tenth <= 25 * 6 + 10, true);
    const idle = perRun[perRun.length - 1];
    is(`a run with every store decided sends at most 10 Redis commands (it sent ${idle})`, idle <= 10, true);
    const before = commands;
    await (await route(request(path))).json();
    is("and so does every later run in the period", commands - before <= 10, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
