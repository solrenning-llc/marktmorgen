import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/goal/route";
import { readGoal } from "@/lib/sales-goal-rules";
import { readSalesGoal } from "@/lib/sales-goal";
import { goalStore } from "./sales-goal-ack-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const key = `nl:goal:${goalStore.statsId}`;
const original = redis.pipeline;
let fault: { command: string; reply: unknown[]; apply?: boolean } | null = null;
let mutations = 0;
redis.pipeline = async commands => {
  const command = commands[0]?.[0];
  if (command === "SET" || command === "DEL") mutations += 1;
  if (fault?.command === command) {
    if (fault.apply) await original(commands);
    return fault.reply;
  }
  return original(commands);
};
async function seed() {
  redis.clear(); fault = null; mutations = 0;
  await original([["SET", key, JSON.stringify({ cents: 5000, currency: "usd", since: "2026-10" })]]);
}
async function submit(cents: unknown) {
  const response = await POST(new Request("https://example.com/api/store/goal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cents }) }) as NextRequest);
  return { status: response.status, body: await response.json() as { ok: boolean; goal?: number; error?: string } };
}
async function main() {
  part("Only an explicit whole amount can change or remove a goal");
  for (const value of [null, undefined, false, true, [], [0], {}, "", "   ", "1e3", "0x10", NaN, Infinity]) {
    is("ambiguous input refused " + String(value), readGoal(value), null);
  }
  for (const value of [0, "0", "000", 3000, "3000", " 3000 "]) is("explicit number retained " + String(value), readGoal(value), Number(value));
  for (const value of [null, false, true, [], [0], {}, "", " ", "1e3", "0x10"]) {
    await seed();
    const answer = await submit(value);
    is("POST refuses ambiguous goal " + JSON.stringify(value), [answer.status, answer.body.ok], [400, false]);
    is("ambiguous input starts no mutation", mutations, 0);
    is("existing goal survives ambiguous input", (await readSalesGoal(goalStore.statsId, "usd")).cents, 5000);
  }
  part("Unknown SET and DEL replies are never saved success");
  for (const [command, cents, replies] of [
    ["SET", 4000, [[], [undefined], [null], [1], ["ok"], ["OK", "extra"]]],
    ["DEL", 0, [[], [undefined], [null], ["OK"], ["1"], [-1], [2], [1, 0]]],
  ] as [string, number, unknown[][]][]) {
    for (const reply of replies) {
      await seed(); fault = { command, reply };
      const answer = await submit(cents);
      is(command + JSON.stringify(reply) + ": unknown reply is not success", [answer.status, answer.body.ok, answer.body.goal], [500, false, undefined]);
      is("the unperformed write kept the original target", (await readSalesGoal(goalStore.statsId, "usd")).cents, 5000);
      is("only the existing mutation attempted", mutations, 1);
    }
  }
  await seed(); fault = { command: "SET", reply: [], apply: true };
  const lost = await submit(4000);
  is("applied write with lost acknowledgement is still unconfirmed", [lost.status, lost.body.ok], [500, false]);
  is("no rollback erases an applied target after an unknown reply", (await readSalesGoal(goalStore.statsId, "usd")).cents, 4000);
  await seed();
  const saved = await submit(4000);
  is("confirmed SET retains normal response", [saved.status, saved.body], [200, { ok: true, goal: 4000 }]);
  is("confirmed target actually persisted", (await readSalesGoal(goalStore.statsId, "usd")).cents, 4000);
  const removed = await submit(0);
  is("confirmed DEL of existing target", [removed.status, removed.body], [200, { ok: true, goal: 0 }]);
  const absent = await submit(0);
  is("confirmed DEL of absent target", [absent.status, absent.body], [200, { ok: true, goal: 0 }]);
  is("confirmed removal actually persisted", (await readSalesGoal(goalStore.statsId, "usd")).cents, 0);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
