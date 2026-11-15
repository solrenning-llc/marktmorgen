/**
 * Issue #4729 (Codex X8, reproduced by Claude 2): an unreadable index of the stores with payment requests was read as
 * empty, so the checkout sweep skipped them and moved its cursor on. Synthetic: the Redis stub, stand-in providers.
 */
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});

async function withReply(name: string, reply: () => unknown, run: () => Promise<unknown>, key: string): Promise<void> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === name && commands[0]?.[1] === key) return [reply()];
    return real(commands);
  }) as typeof redis.pipeline;
  try { await run(); } finally { redis.pipeline = real; }
}

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  process.env.STRIPE_SECRET_KEY = "sk_test_conditions_only_a_stand_in";
  const index = "nl:payreq:stores";
  const cursor = "nl:sweep:cursor";
  part("An unreadable payment-request store index leaves the sweep's place for the retry");
  for (const [label, reply] of [["malformed", () => 12], ["timeout", () => { throw new Error("synthetic Redis timeout"); }]] as const) {
    await redis.pipeline([["SADD", index, "request-store"], ["SET", cursor, "0|1"]]);
    let outcome = "resolved";
    await withReply("SMEMBERS", reply as () => unknown, async () => {
      try { await sweepCheckouts(Date.now() + 20_000); } catch { outcome = "rejected"; }
    }, index);
    const after = await redis.pipeline([["GET", cursor]]);
    is(`${label}: the sweep stops instead of skipping the stores`, outcome, "rejected");
    is(`${label}: the cursor is left in place`, after, ["0|1"]);
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
