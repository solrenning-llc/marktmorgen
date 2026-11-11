/**
 * What a store's closing costs (added 18 October 2026), held to the owner's
 * rule: per customer, inside that customer's own margin. A closing is part
 * of one store's life, so its worst cost is priced once for each store and
 * charged against each of its payments (tests/plan-cost-registry.ts,
 * PER_PAYMENT_LINES, closure), and tests/spend-floor.test.ts holds every
 * plan, by the month and by the year, to the floor with its buffer with it
 * counted: a store that paid one month and closed carries all of it.
 *
 * What is held here:
 *
 *   - the closure's parts are finite, and the line is in the payments' sum;
 *   - what a unit writes, which goes by itself, is paid for to its end by
 *     the window that wrote it (partAverage at least lifetimeByteMonths), so
 *     neither what it leaves after a plan ends nor after the closing day is
 *     counted again;
 *   - a buyer's library entry is priced with its order for its whole life,
 *     the quarters it is kept, and runs out by itself (CLOSING, lapses);
 *   - the export a paying store takes from its studio figure costs no more
 *     than the units it takes, Stripe's pages included;
 *   - once its plan has ended, its ENDED_STORE_EXPORTS whole exports are its
 *     own, never taken from a figure or the share of stores that pay
 *     nothing, and priced in the closure;
 *   - the walk, reading the whole database, is the company's scheduled job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TIERS } from "@/lib/plan";
import { CLOSING } from "@/lib/data-families";
import { DATA_ROOM_BYTES, ENTRY_BYTES } from "@/lib/store-data-rules";
import { EXPORT_PAGES } from "@/lib/stats";
import { EXPORT_STRIPE_PAGES, exportUnits } from "@/lib/store-export";
import { PERSON_RECORD_MONTHS, QUARTERS_KEPT, quarterOf, quarterStart } from "@/lib/joined-stores";
import { WALK_COUNT } from "@/lib/closed-store-data";
import { ENDED_STORE_EXPORTS } from "@/lib/plan-closing-rules";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMAND, DB_BYTE, DB_BYTE_MONTH, ORDER_COST, ORDER_LIBRARY, PER_PAYMENT_LINES, UNIT_COST, closureCost, exportCommands, exportCost, nonPayingWorst } from "./plan-cost-registry";
import { FAMILIES, lifetimeByteMonths, partAverage } from "./store-data-registry";
import { MAX_TEAM } from "@/lib/team";
import { STORE_LOCK_TRIES } from "@/lib/read-ceilings";
import { PREPARE_COMMANDS } from "./plan-cost-registry";

test("a closing's worst cost, part by part, for each plan and for a free trial", () => {
  for (const tier of TIERS) {
    const c = closureCost(tier);
    console.log(`${tier}: deletes $${c.deletes.toFixed(4)}, followers $${c.follows.toFixed(4)}, its whole export after its plan ended $${c.exports.toFixed(4)}, last steps $${c.prepare.toFixed(4)}: $${c.total.toFixed(4)}, once for the store; each order $${ORDER_LIBRARY.toFixed(6)} for its buyers' library entries`);
    for (const value of Object.values(c)) assert.ok(Number.isFinite(value) && value >= 0, tier);
  }
  const trial = closureCost("creator", true);
  console.log(`a free trial's store: $${trial.total.toFixed(4)}, in the share of stores that pay nothing`);
  assert.ok(trial.total <= closureCost("creator").total);
  assert.ok(nonPayingWorst() >= trial.total);
  assert.ok(PER_PAYMENT_LINES.some((line) => line.id === "closure" && line.monthlyUsd("creator") === closureCost("creator").total));
});

test("what a unit writes is paid for to its end by the window that writes it, so nothing that goes by itself is priced again", () => {
  for (const tier of TIERS) {
    for (const [name, family] of Object.entries(FAMILIES)) {
      for (const part of family.parts ?? []) {
        if (!("per" in part)) continue;
        assert.ok(partAverage(part, tier) >= lifetimeByteMonths(part, tier), `${name}, ${tier}: a window pays ${partAverage(part, tier)} byte-months for ${lifetimeByteMonths(part, tier)}`);
      }
    }
  }
});

test("a buyer's library entry: its order pays for its whole life, which ends by itself", () => {
  assert.equal(PERSON_RECORD_MONTHS, QUARTERS_KEPT * 3);
  assert.ok(QUARTERS_KEPT >= 13, "at least three years after the quarter it was written in");
  assert.equal(ORDER_LIBRARY, 2 * ENTRY_BYTES * PERSON_RECORD_MONTHS * DB_BYTE_MONTH);
  assert.ok(ORDER_COST > ORDER_LIBRARY);
  for (const family of ["nl:lib:", "nl:lib:joined:"]) {
    const rule = CLOSING[family];
    assert.ok(rule.how === "lapses" && rule.days >= PERSON_RECORD_MONTHS * 31, family);
  }
  // A quarter's set ends QUARTERS_KEPT quarters on: three years at the least, three and a quarter at the most.
  const at = Date.UTC(2026, 11, 31, 23, 0);
  const ends = quarterStart(quarterOf(at) + QUARTERS_KEPT);
  assert.ok(ends - at >= 3 * 365 * 86_400_000 && ends - Date.UTC(2026, 9, 1) <= PERSON_RECORD_MONTHS * 31 * 86_400_000);
});

test("an export a paying store takes from its studio figure costs no more than the units it takes, Stripe's pages included", () => {
  assert.equal(EXPORT_STRIPE_PAGES, 2 * EXPORT_PAGES, "its checkouts' and its one-click extras' pages");
  for (const tier of TIERS) {
    for (const bytes of [0, 1_000, 1_000_000, DATA_ROOM_BYTES[tier]]) {
      const shape = { bytes, commands: exportCommands(bytes) };
      const units = exportUnits(shape);
      assert.ok(units * UNIT_COST.studio >= exportCost(bytes, shape.commands), `${tier}, ${bytes} bytes: ${units} units at $${UNIT_COST.studio} for $${exportCost(bytes, shape.commands)}`);
    }
  }
});

test("once a plan has ended, its whole exports are its own: counted for the store, never refused for want of a figure or a place, and priced in its closing", () => {
  const route = readFileSync(join(process.cwd(), "app/api/store/export/route.ts"), "utf8");
  const ended = route.slice(route.indexOf('if (standingOf(store) === "ended")'), route.indexOf("} else {", route.indexOf('if (standingOf(store) === "ended")')));
  assert.ok(ended.includes("ENDED_STORE_EXPORTS") && ended.includes("INCR"), "counted for the store");
  assert.ok(!ended.includes("takeAllowance") && !ended.includes("admitNonPaying"), "never from a figure or the share of stores that pay nothing");
  assert.ok(ENDED_STORE_EXPORTS >= 1);
  for (const tier of TIERS) assert.equal(closureCost(tier).exports, ENDED_STORE_EXPORTS * exportCost(DATA_ROOM_BYTES[tier] + 1_000_000));
});

test("the walk, the company's: what it costs a walk for every million keys the database holds", () => {
  const perWalk = (1_000_000 / WALK_COUNT) * COMMAND + 1_000_000 * 80 * DB_BYTE;
  console.log(`a walk reads a million keys for $${perWalk.toFixed(4)}; at one a day, $${(31 * perWalk).toFixed(3)} a month for every million keys`);
  assert.ok(perWalk < 0.01);
});

test("a closing's last steps pay for the record's going under the store's lock, its read again and the entry written again", () => {
  const source = readFileSync(join(process.cwd(), "lib/store.ts"), "utf8");
  const close = source.slice(source.indexOf("export async function closeStoreRecord"), source.indexOf("export type RenameResult"));
  // The lock is the store's own, tried again for LOCK_WAIT_MS (8 seconds): at most STORE_LOCK_TRIES, as ensureListId's.
  assert.match(close, /takeLock\(lockKeyOf\(owner\), LOCK_SECONDS, LOCK_WAIT_MS\)/);
  assert.match(source, /const LOCK_WAIT_MS = 8_000;/);
  assert.match(close, /\["GET", owner\]/);
  assert.match(close, /deleteIfHeldOnly\(held,/);
  assert.match(close, /releaseLock\(held\)/);
  // Its id leaves the account's list at both addresses read: one more SREM than the first read's (Claude 6 on #3643).
  assert.match(close, /\["SREM", account, store\.sid\]/);
  const hosts = (1 + MAX_TEAM) * (2 * 50 + 5);
  // The lock's tries, the GET, the entry's HSET again, the second account's SREM, the fenced delete's script (EVAL, GET,
  // DEL) and the release's (EVAL, GET, DEL).
  assert.ok(PREPARE_COMMANDS >= hosts + 100 + STORE_LOCK_TRIES + 1 + 1 + 1 + 3 + 3, `last steps priced at ${PREPARE_COMMANDS} commands`);
});
