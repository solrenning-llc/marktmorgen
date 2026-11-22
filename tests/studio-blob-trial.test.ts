/**
 * Claude 7's MEDIUM 2 on #2852, held by Claude 4 (6912440389, 6921673861): a store in its trial does studio picture
 * doors, checks and page saves up to its trial studio figure (NON_PAYING_ALLOWANCES.trial.studio), the same Blob work
 * the studio-blob line prices for a paying store (studioBlobMonthly). The non-paying worst case (nonPayingWorst) must
 * carry it: a cost not counted is unknown, never zero.
 */
import { readFileSync } from "node:fs";
import { NON_PAYING_ALLOWANCES } from "@/lib/store-allowance-rules";
import { done, is, part } from "./check";
import { nonPayingWorst, studioBlobMonthly } from "./plan-cost-registry";

part("A trial store's studio picture work is in the non-paying worst case");
const source = readFileSync("tests/plan-cost-registry.ts", "utf8");
const start = source.indexOf("export function nonPayingWorst");
const body = source.slice(start, source.indexOf("\n}\n", start));
is("nonPayingWorst adds the trial's studio Blob work at its own studio figure", body.includes("studioBlobMonthly(allowances.studio)"), true);
const studio = studioBlobMonthly(NON_PAYING_ALLOWANCES.trial.studio);
is("that work costs something (never zero)", studio > 0, true);
is("and the worst case is at least that work", nonPayingWorst() >= studio, true);
done();
