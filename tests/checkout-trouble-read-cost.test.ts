import assert from "node:assert/strict";
import { noteCheckoutTrouble } from "@/lib/checkout-trouble";
import { StripeError } from "@/lib/stripe-account";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { FAMILIES } from "./store-data-registry";

/** Report-only storage proof: the reader fix does not fund old day fields. */
async function main() {
  const statsId = "c".repeat(32);
  const first = Date.parse("2020-01-01T12:00:00Z");
  const day = 86_400_000;
  for (let i = 0; i < 400; i += 1) {
    if (i) redis.advance(day);
    await noteCheckoutTrouble({ statsId } as Store, new StripeError(500, "unavailable", "Try again later."), first + i * day);
  }
  const [raw] = await redis.pipeline([["HGETALL", `nl:cotrouble:${statsId}`]]);
  assert.ok(Array.isArray(raw));
  const payload = raw.reduce<number>((sum, value) => sum + Buffer.byteLength(String(value)), 0);
  const allocated = FAMILIES["nl:cotrouble:@lib/checkout-trouble.ts"].parts![0].capped!("creator");
  assert.equal(raw.length / 2, 401);
  console.log(`MEASURE storage: ${raw.length / 2} fields, ${payload} payload bytes against ${allocated} registered bytes; Redis overhead excluded`);
  assert.ok(payload <= allocated, `stored payload ${payload} exceeds its paid allocation ${allocated}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
