import assert from "node:assert/strict";
import test from "node:test";
import * as sent from "@/lib/sent-bytes";
import { agendaReadUnits } from "@/lib/person-agenda";
import { ledgerUnits } from "@/lib/segments";

// The parent has no IncludedBytes export. Pass undefined there, preserving the
// old real helpers and the same expectations; no replacement implementation.
const Constructor = Reflect.get(sent, "IncludedBytes") as (new () => unknown) | undefined;
const ledger = ledgerUnits as (bytes: number, included?: unknown) => number;
const tasks = agendaReadUnits as (people: number, included?: unknown) => number;
const sending = sent.sentUnits as (bytes: number, included?: unknown) => number;

test("control: standalone sizes retain their previous counted units", () => {
  assert.deepEqual([0, 50_000, 50_001, 1_000_000, 1_000_001].map((size) => ledger(size)), [0, 0, 1, 1, 2]);
});

test("one page spends its included bytes once across the six real helpers", () => {
  const budget = Constructor ? new Constructor() : undefined;
  const parts = [ledger(50_000, budget), ledger(50_000, budget), tasks(2, budget),
    ledger(50_000, budget), ledger(50_000, budget), sending(50_000, budget)];
  assert.deepEqual(parts, [0, 1, 1, 1, 1, 1]);
});
