/**
 * The cost of noteBoughtAgain (lib/learn.ts), the mark a paid checkout leaves for the daily drip job when a student
 * whose row holds an earlier day bought a course again (PR #3369). It runs on every confirmed paid checkout with a
 * course in it (lib/purchase-email.ts, confirmOnce): one HGET of the student's row for each course the order hands
 * over, one SADD for each course bought again, and one DEL of the buyer's kept answer. An order hands over at most
 * MAX_DELIVERED products (lib/bundle-rules.ts), so every one may be a course. Until this line it had no price in the
 * registry (the Claude 4 AA finding of 21 November 2026, relayed by Claude 4 3rC): unknown is never zero.
 *
 * Holds: at its worst (every product of the order a course, every course bought again) the commands it sends and the
 * rows it reads stay within ORDER_BOUGHT_AGAIN_COMMANDS and ORDER_BOUGHT_AGAIN_BYTES; the drip index's part of the same
 * call (indexBoughtAgain, #3344: every course's card read, the pairs written) within ORDER_BOUGHT_AGAIN_INDEX_COMMANDS
 * and ORDER_BOUGHT_AGAIN_INDEX_BYTES, each its own checked bound; and the registry prices them on
 * every order of each plan's figure (COST_LINES "order-bought-again") and on the trial's orders (nonPayingWorst).
 * Synthetic: the Redis stand-in only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_DELIVERED } from "@/lib/bundle-rules";
import { emailKey, noteBoughtAgain } from "@/lib/learn";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { NOTE_MARK_SECONDS } from "@/lib/purchase-email";
import type { Store } from "@/lib/store";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const { COMMAND, DB_BYTE } = registry;
// Read by name, so this test fails (not the build) while the line is missing.
const commands = (registry as Record<string, unknown>).ORDER_BOUGHT_AGAIN_COMMANDS;
const bytes = (registry as Record<string, unknown>).ORDER_BOUGHT_AGAIN_BYTES;
const perOrder = (registry as Record<string, unknown>).ORDER_BOUGHT_AGAIN;
const indexCommands = (registry as Record<string, unknown>).ORDER_BOUGHT_AGAIN_INDEX_COMMANDS;
const indexBytes = (registry as Record<string, unknown>).ORDER_BOUGHT_AGAIN_INDEX_BYTES;
const perOrderIndex = (registry as Record<string, unknown>).ORDER_BOUGHT_AGAIN_INDEX;
/** The note's own commands (#3369): each course's row, each course's again set, the buyer's kept answer. */
const noteOwn = (c: (string | number)[]) =>
  (c[0] === "HGET" && String(c[1]).endsWith(":students")) || (c[0] === "SADD" && String(c[1]).endsWith(":again")) || (c[0] === "DEL" && String(c[1]).startsWith("nl:learn:paid:"));

const store = { handle: "again-school", previousHandles: [], statsId: "7".repeat(32), sid: "8".repeat(32), email: "owner@example.test" } as unknown as Store;
const buyer = "again-buyer@example.test";
const paid = Math.floor(Date.UTC(2026, 5, 1) / 1000);

async function main(): Promise<void> {
  part("An order of MAX_DELIVERED courses, every one bought again");
  redis.clear();
  const courseIds = Array.from({ length: MAX_DELIVERED }, (_, i) => String(i).padStart(32, "c"));
  // The row each course keeps for this student, from an earlier day, at the widest a row is read back.
  const row = JSON.stringify({ e: buyer, s: paid - 400 * 86_400, l: paid - 300 * 86_400, x: paid + 900 * 86_400 });
  await redis.pipeline(courseIds.map((id) => ["HSET", `nl:course:${id}:students`, emailKey(buyer), row]));
  // Each course's drip card (lib/learn.ts, registerDrip), so the index's part runs whole: one module that opens over time.
  await redis.pipeline(courseIds.map((id) => ["SET", `nl:drip:card:${id}`, JSON.stringify({ p: `prod_${id.slice(-8)}`, s: null, m: [["module000001", "Month 1", 30, 1]], g: "[]" })]));
  let sent = 0;
  let read = 0;
  let indexSent = 0;
  let indexRead = 0;
  const real = redis.pipeline.bind(redis);
  redis.pipeline = async (list) => {
    const replies = await real(list);
    list.forEach((command, i) => {
      const own = noteOwn(command);
      if (own) sent += 1;
      else indexSent += 1;
      // A reply read back: a string, or a list of strings (the cards' MGET).
      const reply = replies[i];
      const n = typeof reply === "string" ? Buffer.byteLength(reply) : Array.isArray(reply) ? reply.reduce((sum: number, one) => sum + (typeof one === "string" ? Buffer.byteLength(one) : 0), 0) : 0;
      if (own) read += n;
      else indexRead += n;
    });
    return replies;
  };
  let known: boolean;
  try {
    known = await noteBoughtAgain(store, courseIds, buyer, paid);
  } finally {
    redis.pipeline = real;
  }
  is("it is noted for every course", known, true);
  console.log(`  at that worst: ${sent} commands and ${read} bytes read back, against ${String(commands)} and ${String(bytes)}`);
  is("it is the worst: every course read, noted, and the kept answer let go", sent, 2 * MAX_DELIVERED + 1);
  is("with the note mark's GET and SET around it (lib/purchase-email.ts), the line's commands", commands, sent + 2);
  is("the mark is priced for as long as it is kept", Number((registry as Record<string, unknown>).ORDER_BOUGHT_AGAIN_MARK_SECONDS) >= NOTE_MARK_SECONDS, true);
  is("ORDER_BOUGHT_AGAIN_COMMANDS covers every command it sends", typeof commands === "number" && sent <= commands, true);
  is("ORDER_BOUGHT_AGAIN_BYTES covers every row it reads back", typeof bytes === "number" && read <= bytes, true);
  // The drip index's part (#3344): the cards were read and the pairs written.
  console.log(`  the drip index's part: ${indexSent} commands and ${indexRead} bytes read back, against ${String(indexCommands)} and ${String(indexBytes)}`);
  is("the drip index's part ran: the cards read", indexSent > 0 && indexRead > 0, true);
  is("the pairs are in the store's index", Number((await redis.pipeline([["ZCARD", `nl:drip:due:${store.statsId}`]]))[0]) > 0, true);
  is("ORDER_BOUGHT_AGAIN_INDEX_COMMANDS covers every command of the index's part", typeof indexCommands === "number" && indexSent <= indexCommands, true);
  is("ORDER_BOUGHT_AGAIN_INDEX_BYTES covers every card it reads back", typeof indexBytes === "number" && indexRead <= indexBytes, true);

  part("The registry prices it on every order");
  is("one order at its worst, its commands and its bytes", typeof perOrder === "number" && typeof commands === "number" && typeof bytes === "number" && perOrder >= commands * COMMAND + bytes * DB_BYTE - 1e-15, true);
  is("the drip index's part, its commands and its bytes, inside the same order's price", typeof perOrderIndex === "number" && typeof indexCommands === "number" && typeof indexBytes === "number" && perOrderIndex >= indexCommands * COMMAND + indexBytes * DB_BYTE - 1e-15 && typeof perOrder === "number" && typeof commands === "number" && typeof bytes === "number" && perOrder >= commands * COMMAND + bytes * DB_BYTE + perOrderIndex - 1e-15, true);
  const lines = registry.COST_LINES as unknown as readonly { id: string; monthlyUsd: (tier: "creator" | "pro" | "scale") => number }[];
  const line = lines.find((l) => l.id === "order-bought-again");
  is("the line order-bought-again is in the registry", Boolean(line), true);
  for (const tier of ["creator", "pro", "scale"] as const) {
    is(`${tier}: every order of the plan's figure at that worst`, line && typeof perOrder === "number" ? line.monthlyUsd(tier) >= ORDERS_INCLUDED[tier] * perOrder - 1e-12 : false, true);
  }
  const source = readFileSync(join(process.cwd(), "tests/plan-cost-registry.ts"), "utf8");
  is("the trial's orders pay for it too (nonPayingWorst)", /TRIAL_ORDERS \* \(ORDER_COST \+ ORDER_BOUGHT_AGAIN\)/.test(source), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
