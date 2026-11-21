/**
 * A vault open refused for storage spends no monthly upload budget since #4019 (lib/vault-storage.ts, admit), so what
 * it did cost is priced on the integration unit the pass took ("vault-open"): the listings that measured storage, the
 * expired session admission retired and the ledger commands it sent (lib/spend-cost-table.ts,
 * vaultRefusedPassMicroUsd). And every open is priced for the ledger commands a vault open sends, measured on real
 * Redis (UPLOAD_BUDGET_COMMANDS_PER_OPEN, held by scripts/test_upload_budget_redis.py). Review of #4019 (Claude 7).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOB_ADVANCED_MICRO_USD_PER_MILLION, R2_CLASS_A_MICRO_USD_PER_MILLION, STREAM_API_ALLOWANCE_MICRO_USD_PER_MILLION, UPLOAD_BUDGET_COMMANDS_PER_OPEN,
  UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, uploadOperationsMicroUsd, vaultRefusedPassMicroUsd,
} from "@/lib/spend-cost-table";
import { BLOB_LIST_PAGES } from "@/lib/storage-rules";
import { STREAM_HELD_REQUESTS } from "@/lib/stream-rules";
import { VAULT_LIST_PAGES } from "@/lib/vault-rules";
import { COST_LINES, UNIT_COST, VAULT_REFUSED_PASS } from "./plan-cost-registry";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";

test("a refused pass is priced at least at its listings and its ledger commands", () => {
  const floor = (VAULT_LIST_PAGES * R2_CLASS_A_MICRO_USD_PER_MILLION + BLOB_LIST_PAGES * BLOB_ADVANCED_MICRO_USD_PER_MILLION
    + STREAM_HELD_REQUESTS * STREAM_API_ALLOWANCE_MICRO_USD_PER_MILLION + UPLOAD_BUDGET_COMMANDS_PER_OPEN * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1_000_000;
  assert.ok(vaultRefusedPassMicroUsd() >= floor, `${vaultRefusedPassMicroUsd()} < ${floor}`);
});

test("every integration unit carries a refused pass on top of its call", () => {
  const line = COST_LINES.find((one) => one.id === "integrations")!;
  for (const tier of ["creator", "pro", "scale"] as const) {
    const units = STORE_ALLOWANCES[tier].integration;
    assert.ok(line.monthlyUsd(tier) >= units * (UNIT_COST.integration + vaultRefusedPassMicroUsd() / 1_000_000) - 1e-12, tier);
  }
  assert.ok(VAULT_REFUSED_PASS > 0);
});

test("each open is priced for the ledger commands it sends", () => {
  const one = uploadOperationsMicroUsd(1, 0, 0)!, none = uploadOperationsMicroUsd(0, 0, 0)!;
  assert.ok(one - none >= UPLOAD_BUDGET_COMMANDS_PER_OPEN * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS / 1_000_000);
  assert.ok(UPLOAD_BUDGET_COMMANDS_PER_OPEN >= 74, "the most measured on real Redis");
});
