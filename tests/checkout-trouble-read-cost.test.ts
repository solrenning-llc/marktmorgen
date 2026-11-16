import assert from "node:assert/strict";
import { noteCheckoutTrouble, readTrouble, readTroubleStrict } from "@/lib/checkout-trouble";
import { StripeError } from "@/lib/stripe-account";
import { store as redis } from "./redis-stub";
import type { Store } from "@/lib/store";
import { CHECKOUT_TROUBLE_READ } from "./plan-cost-registry";

const DAY = 86_400_000;
const sid = "c".repeat(32);
const store = { statsId: sid } as Store;
const pipeline = redis.pipeline.bind(redis);
let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); checks += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
}

async function main() {
  // Exercise the actual writer every day: renewing the hash TTL does not expire
  // old fields. No provider is called for a server-side Stripe failure.
  const first = Date.parse("2010-01-01T12:00:00Z");
  const error = new StripeError(500, "unavailable", "Try again later.");
  for (let day = 0; day < 4000; day += 1) {
    if (day) redis.advance(DAY);
    await noteCheckoutTrouble(store, error, first + day * DAY);
  }
  const now = first + 3999 * DAY;
  const [[fields]] = await Promise.all([pipeline([["HLEN", `nl:cotrouble:${sid}`]])]);
  assert.equal(fields, 4001, "the writer preserves all historical day fields");

  for (const reader of [readTrouble, readTroubleStrict]) {
    await check(`${reader.name}: eight fields, one command and a bounded transfer after 4000 days`, async () => {
      const commands: (string | number)[][] = [];
      let bytes = 0;
      redis.pipeline = async (batch) => {
        commands.push(...batch);
        const reply = await pipeline(batch);
        bytes += Buffer.byteLength(JSON.stringify(batch)) + Buffer.byteLength(JSON.stringify(reply));
        return reply;
      };
      try {
        const found = await reader(sid, now);
        assert.equal(found?.week, 7);
        assert.equal(commands.length, 1);
        assert.ok(bytes <= 50_000, `studio's entire priced database transfer is 50000 bytes; reader alone sent ${bytes}`);
        assert.equal(commands[0][0], "HMGET");
        assert.equal(commands[0].length, 10, "command + key + seven days + last");
        assert.ok(bytes <= CHECKOUT_TROUBLE_READ.bytes);
        assert.equal(commands.length, CHECKOUT_TROUBLE_READ.commands);
        assert.equal(commands[0].length - 2, CHECKOUT_TROUBLE_READ.fields);
        console.log(`MEASURE ${reader.name}: ${commands.length} command, ${bytes} bytes`);
      } finally { redis.pipeline = pipeline; }
    });
  }

  for (const response of [[], [null], [[]], [[null]], [[...Array(8).fill(null), null]], [[null, null, null, null, null, null, null, null], []]]) {
    await check(`strict reader refuses partial envelope ${JSON.stringify(response)}`, async () => {
      redis.pipeline = async () => response;
      try { assert.equal(await readTroubleStrict(sid, now), null); }
      finally { redis.pipeline = pipeline; }
    });
  }
  await check("confirmed missing fields are a known quiet week", async () => {
    assert.deepEqual(await readTroubleStrict("d".repeat(32), now), { week: 0, last: null });
  });
  for (const count of [undefined, false, 0, -1, "-1", "1.5", "", "01", "NaN", "9007199254740992"]) {
    await check(`unknown counter ${String(count)} is not zero`, async () => {
      redis.pipeline = async () => [[count, ...Array(7).fill(null)]];
      try {
        assert.equal(await readTroubleStrict(sid, now), null);
        await assert.rejects(() => readTrouble(sid, now));
      } finally { redis.pipeline = pipeline; }
    });
  }
  for (const last of [undefined, false, 0, "invalid", "null", "[]", "{}", JSON.stringify({ at: now, code: "x" }), JSON.stringify({ at: now, code: "x", message: "x".repeat(301) })]) {
    await check(`unknown last reason ${String(last)} is unavailable`, async () => {
      redis.pipeline = async () => [[...Array(7).fill(null), last]];
      try { assert.equal(await readTroubleStrict(sid, now), null); }
      finally { redis.pipeline = pipeline; }
    });
  }
  await check("a known sum that would overflow is unavailable", async () => {
    redis.pipeline = async () => [["9007199254740991", "1", ...Array(6).fill(null)]];
    try { assert.equal(await readTroubleStrict(sid, now), null); }
    finally { redis.pipeline = pipeline; }
  });
  await check("largest writer fields and wide UTF-8 fit the registered transfer ceiling", async () => {
    const day = new Date(now).toISOString().slice(0, 10);
    await pipeline([["HSET", `nl:cotrouble:${sid}`, day, "9007199254740991", "last", JSON.stringify({ at: now, code: "界".repeat(60), message: "界".repeat(300) })]]);
    // Remove the six other selected counts so this safe maximum is the sum.
    await pipeline([["HDEL", `nl:cotrouble:${sid}`, ...Array.from({ length: 6 }, (_, i) => new Date(now - (i + 1) * DAY).toISOString().slice(0, 10))]]);
    let bytes = 0;
    redis.pipeline = async (batch) => {
      const reply = await pipeline(batch);
      bytes += Buffer.byteLength(JSON.stringify(batch)) + Buffer.byteLength(JSON.stringify(reply));
      return reply;
    };
    try {
      const found = await readTroubleStrict(sid, now);
      assert.equal(found?.week, Number.MAX_SAFE_INTEGER);
      assert.equal(found?.last?.message.length, 300);
      assert.ok(bytes <= CHECKOUT_TROUBLE_READ.bytes, `${bytes} exceeds registered ${CHECKOUT_TROUBLE_READ.bytes}`);
      console.log(`MEASURE largest writer fields: ${bytes} bytes`);
    } finally { redis.pipeline = pipeline; }
  });
  await check("writer-permitted JSON escapes fit the registered transfer ceiling", async () => {
    const day = new Date(now).toISOString().slice(0, 10);
    await pipeline([["HSET", `nl:cotrouble:${sid}`, day, "0"]]);
    await noteCheckoutTrouble(store, new StripeError(500, "\u0000".repeat(60), "\u0000".repeat(300)), now);
    let bytes = 0;
    redis.pipeline = async (batch) => {
      const reply = await pipeline(batch);
      bytes += Buffer.byteLength(JSON.stringify(batch)) + Buffer.byteLength(JSON.stringify(reply));
      return reply;
    };
    try {
      const found = await readTroubleStrict(sid, now);
      assert.equal(found?.week, 1);
      assert.equal(found?.last?.message.length, 300);
      console.log(`MEASURE JSON escapes: ${bytes} bytes`);
      assert.ok(bytes <= CHECKOUT_TROUBLE_READ.bytes, `${bytes} exceeds registered ${CHECKOUT_TROUBLE_READ.bytes}`);
    } finally { redis.pipeline = pipeline; }
  });
  console.log(`${checks} checks passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
