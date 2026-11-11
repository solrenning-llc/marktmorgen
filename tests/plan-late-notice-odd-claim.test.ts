/**
 * Claude 1's LOW on #3367 (6799081436): tellLateRefunds read every reply to its claim read but exactly 0 as "already
 * told", so a reply in an odd shape (null, text, a negative or larger number) dropped that payment from those to
 * tell, never counted as untold: the plan could settle as done and its buyer never be emailed (CX-123 rule 24). A
 * reply that is not exactly 0 or 1 is untold, tried again on the next pass.
 */
import { tellLateRefunds } from "@/lib/plan-late-notice";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const given = (invoice: string) => ({ invoice, email: "buyer@example.com", amount: 1_000, currency: "usd", paidAt: now - 3_600 });
  const real = redis.pipeline.bind(redis);
  part("A claim read in an odd shape is untold, never told");
  for (const [label, odd] of [["null", null], ["text", "yes"], ["a negative number", -1], ["two", 2]] as const) {
    redis.clear();
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.every((c) => c[0] === "HEXISTS") ? commands.map(() => odd) : real(commands)) as typeof redis.pipeline;
    let out: { told: number; untold: number } | null = null;
    try {
      out = await tellLateRefunds({ sid: "sidoddclaim01", product: "prod01" }, now - 86_400, [given(`in_odd${label.length}`)], now);
    } finally {
      redis.pipeline = real;
    }
    is(`${label}: counted as untold, so the pass is not done`, [out?.told, out?.untold], [0, 1]);
  }
  part("Control: a claim that says told is told");
  redis.clear();
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.every((c) => c[0] === "HEXISTS") ? commands.map(() => 1) : real(commands)) as typeof redis.pipeline;
  try {
    const out = await tellLateRefunds({ sid: "sidoddclaim01", product: "prod01" }, now - 86_400, [given("in_told1")], now);
    is("1: already told, nothing untold", [out.told, out.untold], [0, 0]);
  } finally {
    redis.pipeline = real;
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
