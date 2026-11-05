// Opt-in financial proof: run through review-c2-service-financial-run.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/store/affiliates/paypal/route';
import { reset, state } from './service-counter-admission-world';
import { calls, events, resetRoute } from './review-c2-service-financial-world';

async function post(op: 'pay' | 'connect') {
  const request = new Request('https://shop.example.test/api/store/affiliates/paypal', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op }),
  });
  return POST(request as NextRequest);
}
function clean() { reset(); resetRoute(); }

for (const op of ['pay', 'connect'] as const) {
  test(`${op}: unknown short counter stops before monthly quota and provider`, async () => {
    for (const reply of [[false, 1], ['OK', null], ['OK', '1'], ['OK', 1, 'extra']]) {
      clean(); state.override = true; state.reply = reply;
      const response = await post(op);
      assert.equal(response.status, 429, JSON.stringify(reply));
      assert.deepEqual(await response.json(), { ok: false, error: 'slow' });
      assert.deepEqual([state.quotaCalls, calls.pay, calls.connect, state.commands.length], [0, 0, 0, 2]);
      assert.deepEqual(events, []);
    }
  });
  test(`${op}: timeout or missing configuration cannot reach payment admission`, async () => {
    for (const configured of [true, false]) {
      clean(); state.configured = configured; state.throws = true;
      assert.equal((await post(op)).status, 429);
      assert.deepEqual([state.quotaCalls, calls.pay, calls.connect, state.commands.length], [0, 0, 0, configured ? 2 : 0]);
    }
  });
  test(`${op}: exact acknowledgment preserves one funded provider call`, async () => {
    for (const acknowledgment of ['OK', null]) {
      clean(); state.override = true; state.reply = [acknowledgment, 1];
      assert.equal((await post(op)).status, 200);
      assert.deepEqual([state.quotaCalls, calls.pay, calls.connect, state.commands.length], [1, op === 'pay' ? 1 : 0, op === 'connect' ? 1 : 0, 2]);
      assert.deepEqual(events, [op]);
      assert.deepEqual(state.commands[0].slice(2), ['0', 'EX', 3600, 'NX']);
      assert.deepEqual(state.commands[1], ['INCR', state.commands[0][1]]);
    }
  });
  test(`${op}: monthly refusal and exceeded short limit preserve no provider effect`, async () => {
    for (const reason of ['used', 'pool', 'unknown'] as const) {
      clean(); state.quota = { ok: false, reason, limit: 1, message: 'Synthetic refusal' };
      const response = await post(op);
      assert.equal(response.status, 429);
      assert.deepEqual(await response.json(), { ok: false, error: 'slow', message: 'Synthetic refusal' });
      assert.deepEqual([state.quotaCalls, calls.pay, calls.connect, state.commands.length], [1, 0, 0, 2]);
    }
    clean(); state.override = true; state.reply = ['OK', op === 'pay' ? 7 : 11];
    assert.equal((await post(op)).status, 429);
    assert.deepEqual([state.quotaCalls, calls.pay, calls.connect, state.commands.length], [0, 0, 0, 2]);
  });
}
