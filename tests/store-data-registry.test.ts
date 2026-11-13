/**
 * Every key family a store can make in the database says how what it keeps
 * is bounded (tests/store-data-registry.ts), and the figures that bound the
 * room hold what the registry adds up. Added 18 October 2026, when the open
 * item database-storage of tests/plan-cost-registry.ts was closed: a new
 * key family fails here until it is counted in the data room, capped, priced
 * by its unit or said to be the company's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FAMILIES, UNITS, afterEndByteMonths, itemBytes, keptParts, partAverage, partPeak, reserveBytes, reservePeakBytes, type Unit } from "./store-data-registry";
import { ADD_ON_LINES, COST_LINES, PER_PAYMENT_LINES } from "./plan-cost-registry";
import { DATA_ROOM_BYTES, ITEM_DATA_BYTES, MAX_ORDER_ITEMS, NON_PAYING_DATA_ROOM_BYTES, ORDER_DATA_BYTES, contentRoomFor, orderDataBytes, orderReserveFor } from "@/lib/store-data-rules";
import { TIERS } from "@/lib/plan";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Every key the code names under "nl:", by the part before its first variable, and the file it is in. */
function familiesInCode(): Set<string> {
  const found = new Set<string>();
  // lib/data-families.ts is the list of these families' names for the code that measures them, not keys of its own.
  for (const file of ["app", "lib"].flatMap((dir) => walk(dir)).filter((file) => file !== "lib/data-families.ts")) {
    for (const m of read(file).matchAll(/[`"'](nl:[^`"'$]*)(\$\{|[`"'])/g)) found.add(`${m[1]}@${file}`);
  }
  return found;
}

test("every key family in the code is in the registry, and every entry is in the code", () => {
  const found = familiesInCode();
  const listed = new Set(Object.keys(FAMILIES));
  const missing = [...found].filter((family) => !listed.has(family)).sort();
  assert.deepEqual(missing, [], "say in tests/store-data-registry.ts how each of these is bounded");
  const stale = [...listed].filter((family) => !found.has(family)).sort();
  assert.deepEqual(stale, [], "remove what the code no longer makes");
});

test("each family is bounded one way at least, and what it says can be checked", () => {
  const lines = new Set([...COST_LINES, ...PER_PAYMENT_LINES, ...ADD_ON_LINES].map((line) => line.id));
  const writes = /\b(takeData|needData|needDataBytes|takeDataBytes|keepFor|noteData|giveData|giveDataBytes)\(|\$\{TAKE_DATA\}/;
  for (const [name, family] of Object.entries(FAMILIES)) {
    assert.ok(family.what.length > 3, `${name}: say what it is`);
    const ways = [family.room?.length ? "room" : "", family.company ? "company" : "", family.line ? "line" : "", family.parts?.length ? "parts" : ""].filter(Boolean);
    assert.ok(ways.length > 0, `${name}: not bounded`);
    // The company's keys are nobody's room, and are not priced as a store's too.
    if (family.company) assert.deepEqual(ways, ["company"], `${name}: the company's, and something else`);
    if (family.company) assert.ok(family.company.length > 10, `${name}: say why it is the company's`);
    if (family.line) assert.ok(lines.has(family.line), `${name}: no line ${family.line}`);
    for (const file of family.room ?? []) {
      assert.ok(existsSync(join(root, file)), `${name}: ${file} is not there`);
      assert.match(read(file), writes, `${name}: ${file} does not take or give the data room`);
    }
    for (const part of family.parts ?? []) {
      assert.ok(part.what.length > 3, `${name}: say what each part is`);
      if ("per" in part) {
        assert.ok(Object.hasOwn(UNITS, part.per), `${name}: no unit ${part.per}`);
        assert.ok(part.days > 0 && part.bytes > 0, `${name}: ${part.what}`);
        if (part.group) {
          const [group] = part.group.split("/");
          const units: Record<string, Unit[]> = { "order kind": ["order"], "email kind": ["own", "access", "store", "monthly"], "request kind": ["request"] };
          assert.ok(Object.hasOwn(units, group), `${name}: no group ${group}`);
          assert.ok(units[group].includes(part.per), `${name}: a ${group} part by ${part.per}`);
        }
      }
      if ("capped" in part) {
        for (const source of part.names) {
          assert.ok(existsSync(join(root, source.file)), `${name}: ${source.file} is not there`);
          const text = read(source.file);
          for (const cited of source.names) assert.ok(text.includes(cited), `${name}: ${source.file} does not hold ${cited}`);
        }
        for (const tier of TIERS) assert.ok(Number.isFinite(part.capped(tier)) && part.capped(tier) >= 0, `${name}, ${tier}`);
      }
      if ("kept" in part) assert.ok(part.kept > 0, name);
      if ("item" in part) assert.ok(part.item > 0, name);
    }
  }
});

test("what an order keeps for good is written where it is measured, and charged what it really adds", () => {
  // Since 18 October 2026 an order is no longer charged a fixed ceiling:
  // every record it keeps is written by lib/order-data.ts, which charges the
  // room what each write adds (tests/order-data.test.ts,
  // scripts/test_order_data_redis.py). So every file a kept or item part
  // names must write through it.
  // Rule 23 (review of #3448, 9 November 2026): orderWriteIfSame, the same write behind a check of the row it was decided from, counts as writing through lib/order-data.ts; lib/contacts.ts now calls only that one.
  const files = new Set<string>();
  for (const [name, family] of Object.entries(FAMILIES)) {
    if ((family.parts ?? []).some((part) => "kept" in part || "item" in part)) files.add(name.slice(name.indexOf("@") + 1));
  }
  assert.ok(files.size >= 20, `only ${files.size} files keep what an order leaves`);
  for (const file of files) assert.match(read(file), /\borderWrite(Charged|IfSame)?\(/, `${file} keeps what an order leaves and does not write it through lib/order-data.ts`);
  assert.doesNotMatch(read("lib/orders.ts"), /chargeOrderData|ORDER_DATA_BYTES/, "an order is charged a fixed ceiling again");
});

test("what an order can keep for good fits what every checkout holds before it opens", () => {
  const kept = keptParts().reduce((sum, part) => sum + part.bytes, 0);
  assert.ok(kept <= ORDER_DATA_BYTES, `an order keeps ${kept} bytes, ORDER_DATA_BYTES is ${ORDER_DATA_BYTES}`);
  assert.ok(itemBytes() <= ITEM_DATA_BYTES, `a product keeps ${itemBytes()} bytes, ITEM_DATA_BYTES is ${ITEM_DATA_BYTES}`);
  assert.equal(orderDataBytes(1), ORDER_DATA_BYTES + ITEM_DATA_BYTES);
  assert.equal(orderDataBytes(MAX_ORDER_ITEMS + 50), ORDER_DATA_BYTES + MAX_ORDER_ITEMS * ITEM_DATA_BYTES);
  assert.equal(orderDataBytes(0), orderDataBytes(1));
});

test("the room keeps space for its orders, and every plan's room is larger than a store that pays nothing", () => {
  const paid = (tier: (typeof TIERS)[number]) => ({ tier, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "" });
  for (const tier of TIERS) {
    const store = paid(tier);
    assert.ok(orderReserveFor(store) > 0 && contentRoomFor(store) > 0, tier);
    assert.ok(orderReserveFor(store) < DATA_ROOM_BYTES[tier] / 2, `${tier}: orders' reserve takes half the room`);
    assert.ok(DATA_ROOM_BYTES[tier] > NON_PAYING_DATA_ROOM_BYTES.trial, tier);
  }
  assert.ok(DATA_ROOM_BYTES.creator < DATA_ROOM_BYTES.pro && DATA_ROOM_BYTES.pro < DATA_ROOM_BYTES.scale);
});

test("the arithmetic: an average never above what is kept at once, and every plan's total is finite", () => {
  for (const tier of TIERS) {
    for (const family of Object.values(FAMILIES)) for (const part of family.parts ?? []) assert.ok(partAverage(part, tier) <= partPeak(part, tier), `${family.what}, ${tier}`);
    const average = reserveBytes(tier), peak = reservePeakBytes(tier), after = afterEndByteMonths(tier, 37);
    assert.ok(Number.isFinite(average) && Number.isFinite(peak) && Number.isFinite(after) && average > 0 && peak >= average, tier);
    console.log(`${tier}: room ${(DATA_ROOM_BYTES[tier] / 1e6).toFixed(0)} MB; outside it ${(average / 1e6).toFixed(1)} MB on average, ${(peak / 1e6).toFixed(1)} MB at once`);
  }
  assert.ok(reserveBytes("creator") <= reserveBytes("pro") && reserveBytes("pro") <= reserveBytes("scale"));
});

test("the cost registry prices the room and what is kept outside it, and keeps nothing open", () => {
  assert.ok(COST_LINES.some((line) => line.id === "database-storage"));
  assert.ok(PER_PAYMENT_LINES.some((line) => line.id === "retained-data"));
});
