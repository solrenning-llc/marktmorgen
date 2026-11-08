/** C4-0313 conditional availability proof. Actual askModel/ledger client, contract Redis and fake HTTP only. */
import test from "node:test";
import assert from "node:assert/strict";
import { askModel, postToModel } from "@/lib/ai";
import { aiSpendLedgerKey, aiSpendPolicySnapshot } from "@/lib/ai-spend-policy";
import { CURRENT_AI_SPEND_POLICY as policy } from "./ai-spend-approved-policy";
import { reset, seed, ledger, calls } from "./ai-spend-redis";
import { calendarPeriod, calendarPeriodId } from "./billing-period-fixture";
import type { Store } from "@/lib/store";

const store = { statsId: "one", tier: "creator", createdAt: 1, subscriptionActive: true, subscriptionId: "test-subscription", trialEnds: 0, planEndedAt: "", period: calendarPeriod() } as unknown as Store;
const key = aiSpendLedgerKey(new Date().toISOString().slice(0, 7));
const field = "store:one:" + calendarPeriodId();
function start(): void {
  reset();
  seed(key, "test_review", aiSpendPolicySnapshot(policy));
  process.env.ANTHROPIC_API_KEY = "sk-ant-" + "x".repeat(30);
}

test("control: the existing postToModel contract classifies HTTP429 as billed false", async () => {
  start(); const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response("synthetic rejection", { status: 429 });
  try { assert.deepEqual(await postToModel("{}", 500), { ok: false, billed: false }); }
  finally { globalThis.fetch = previous; }
});

test("PROPOSED C4 contract: confirmed non-billed rejection releases this store's hold before retry", async () => {
  start(); const previous = globalThis.fetch; let dispatched = 0;
  const predispatch: { company: string | undefined; store: string | undefined; bytes: number }[] = [];
  globalThis.fetch = async (_input, init) => {
    dispatched++;
    predispatch.push({ company: ledger.get(key)?.get("company"), store: ledger.get(key)?.get(field), bytes: Buffer.byteLength(String(init?.body ?? "")) });
    return new Response("synthetic rejection", { status: 429 });
  };
  try {
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push(await askModel(store, "system", "prompt", 100, "claude-sonnet-5-5"));
    const observed = { dispatched, company: ledger.get(key)?.get("company"), store: ledger.get(key)?.get(field) };
    console.log("Z_REJECTED_HOLD", JSON.stringify({ observed, outcomes, predispatch, commands: calls.flat().length }));
    assert.deepEqual(outcomes, [null, null, null, null]);
    assert.ok(predispatch.every(row => Number(row.company) >= 100 && Number(row.store) >= 100), "every fixture dispatch is reserved beforehand");
    assert.deepEqual(observed, { dispatched: 4, company: "0", store: "0" });
  } finally { globalThis.fetch = previous; }
});

test("control: lost response is unknown and keeps its maximum", async () => {
  start(); const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("synthetic lost response"); };
  try {
    await assert.rejects(askModel(store, "system", "prompt", 100, "claude-sonnet-5-5"));
    assert.equal(ledger.get(key)?.get("company"), "100");
    assert.equal(ledger.get(key)?.get(field), "100");
  } finally { globalThis.fetch = previous; }
});

test("control: successful response retains the separately reviewed maximum", async () => {
  start(); const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ content: [{ type: "text", text: "A draft" }], usage: { input_tokens: 1, output_tokens: 1 } });
  try {
    assert.equal(await askModel(store, "system", "prompt", 100, "claude-sonnet-5-5"), "A draft");
    assert.equal(ledger.get(key)?.get("company"), "100");
  } finally { globalThis.fetch = previous; }
});
