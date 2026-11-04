/**
 * The four reads of inbox C4-4 (4 November 2026; owner's rule MR: a ceiling
 * before every spend) take at least their worst case before reading
 * (lib/read-ceilings.ts). Kept apart from tests/plan-cost-registry.test.ts,
 * which other agents' open pull requests hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { UNIT_COST, readShapeCost } from "./plan-cost-registry";
import {
  CALENDAR_BUILD_SHAPE, CALENDAR_BUILD_UNITS, CALENDAR_READ_SHAPE, CALENDAR_READ_UNITS, SEARCH_DM_SHAPE, SEARCH_DM_UNITS, SEARCH_REQUEST_UNITS,
  SEARCH_ROOM_SHAPE, SEARCH_ROOM_UNITS, SEARCH_SECONDS, SEARCH_SHAPE, TOTALS_STORE_SHAPE, TOTALS_STORE_UNITS, UPDATE_READ_SHAPE, UPDATE_READ_UNITS,
  WALK_STEP_SHAPE, WALK_STEP_UNITS,
} from "@/lib/read-ceilings";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

test("the four reads of C4-4 take at least their worst before reading (lib/read-ceilings.ts)", () => {
  // The community search takes the buyers' figure from a member (never the visits' requests) and studio requests from the creator: each held in its own units.
  const search: [string, typeof SEARCH_REQUEST_UNITS, number][] = [
    ["community search", SEARCH_REQUEST_UNITS, readShapeCost(SEARCH_SHAPE)],
    ["its room", SEARCH_ROOM_UNITS, readShapeCost(SEARCH_ROOM_SHAPE)],
    ["its messages", SEARCH_DM_UNITS, readShapeCost(SEARCH_DM_SHAPE)],
    ["a step of its one-time walk", WALK_STEP_UNITS, readShapeCost(WALK_STEP_SHAPE)],
  ];
  const held: [string, number, number, number][] = [
    ...search.flatMap(([what, units, worst]): [string, number, number, number][] => [
      [`${what}, a member's (buyers' figure)`, units.buyer, UNIT_COST.buyer, worst],
      [`${what}, the creator's (studio)`, units.studio, UNIT_COST.studio, worst],
    ]),
    ["the booking calendar's answer", CALENDAR_READ_UNITS, UNIT_COST.studio, readShapeCost(CALENDAR_READ_SHAPE)],
    ["the booking calendar made again", CALENDAR_BUILD_UNITS, UNIT_COST.studio, readShapeCost(CALENDAR_BUILD_SHAPE)],
    ["a product update's reading of every sale", UPDATE_READ_UNITS, UNIT_COST.studio, readShapeCost(UPDATE_READ_SHAPE)],
    ["one store's numbers on the totals page", TOTALS_STORE_UNITS, UNIT_COST.studio, readShapeCost(TOTALS_STORE_SHAPE)],
  ];
  for (const [what, units, each, worst] of held) {
    assert.ok(units * each >= worst, `${what}: ${units} x ${each} < ${worst}`);
    console.log(`${what}: $${worst.toFixed(6)} at most, taken first as ${units} units at $${each.toFixed(6)}`);
  }
  // The search page's time limit is the one its shape is priced at; a page cut at it has spent no more.
  assert.equal(SEARCH_SHAPE.seconds, SEARCH_SECONDS);
  assert.ok(read("app/[handle]/community/search/page.tsx").includes(`export const maxDuration = ${SEARCH_SECONDS};`));
  // A totals reading costs more than a page, so it is no longer the page's units.
  assert.ok(TOTALS_STORE_UNITS >= STUDIO_PAGE_UNITS);
});
