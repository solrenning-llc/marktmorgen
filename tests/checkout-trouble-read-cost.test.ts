import assert from "node:assert/strict";
import { noteCheckoutTrouble, readTrouble, readTroubleStrict } from "@/lib/checkout-trouble";
import { StripeError } from "@/lib/stripe-account";
import { store as redis } from "./redis-stub";
import type { Store } from "@/lib/store";

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
  console.log(`${checks} checks passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
