import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/store/affiliates/paypal/route";
import { withinService, withinServiceWhy } from "@/lib/metered-limits";
import { reset, state } from "./service-counter-admission-world";
import { payout, store } from "./review-e2-service-paypal-world";

const request = () => new Request("https://example.com/api/store/affiliates/paypal", { method: "POST" });

test("the actual PayPal payout route stops before its payout helper on unknown counter replies", async () => {
  for (const reply of [undefined, null, [], ["OK"], ["OK", "1"], ["OK", 0], ["queued", 1]]) {
    reset(); payout.calls = 0; state.override = true; state.reply = reply;
    const response = await POST(request() as never);
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { ok: false, error: "slow" });
    assert.equal(payout.calls, 0);
    assert.equal(state.quotaCalls, 0);
    assert.equal(state.commands.length, 2);
  }
});

test("known SET NX null and confirmed positive integer preserve the payout route", async () => {
  for (const set of ["OK", null]) {
    reset(); payout.calls = 0; state.override = true; state.reply = Object.freeze([set, 1]);
    const response = await POST(request() as never);
    assert.equal(response.status, 200);
    assert.equal(payout.calls, 1);
    assert.equal(state.quotaCalls, 1);
  }
});

test("counter timeout, absent configuration and all monthly refusals stop the actual payout route", async () => {
  for (const kind of ["timeout", "not-configured", "used", "pool", "unknown"] as const) {
    reset(); payout.calls = 0;
    if (kind === "timeout") state.throws = true;
    else if (kind === "not-configured") state.configured = false;
    else state.quota = { ok: false, reason: kind, message: "Synthetic quota refusal", limit: 1 };
    assert.equal((await POST(request() as never)).status, 429);
    assert.equal(payout.calls, 0);
    assert.equal(state.quotaCalls, kind === "used" || kind === "pool" || kind === "unknown" ? 1 : 0);
  }
});

test("inherited or accessor counter slots cannot authorize provider work or execute a getter", async () => {
  let getters = 0;
  const accessor = ["OK", 1];
  Object.defineProperty(accessor, "1", { enumerable: true, get() { getters += 1; return 1; } });
  const inherited = new Array(2);
  Object.setPrototypeOf(inherited, { 0: "OK", 1: 1 });
  for (const reply of [accessor, inherited]) {
    reset(); state.override = true; state.reply = reply;
    assert.deepEqual(await withinServiceWhy("paypal-pay", store.handle, 6, 3_600, store), { reason: "tries" });
    assert.equal(state.quotaCalls, 0);
  }
  assert.equal(getters, 0);
});

test("invalid short-window inputs spend nothing and concurrent confirmed calls retain the original bound", async () => {
  for (const [limit, seconds] of [[0, 60], [-1, 60], [1.5, 60], [NaN, 60], [1, 0], [1, 0.5]]) {
    reset();
    assert.equal(await withinService("paypal-pay", store.handle, limit, seconds, store), false);
    assert.equal(state.commands.length, 0);
    assert.equal(state.quotaCalls, 0);
  }
  reset();
  const allowed = await Promise.all(Array.from({ length: 8 }, () => withinService("paypal-pay", store.handle, 1, 60, store)));
  assert.equal(allowed.filter(Boolean).length, 1);
  assert.equal(state.quotaCalls, 1);
  assert.equal(state.commands.length, 16);
});
