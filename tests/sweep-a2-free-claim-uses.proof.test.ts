/**
 * Sweep A2 proof (CX-123 rule 24), synthetic only. lib/free.ts spendClaim, lines 295-299:
 *   const [count] = await redisPipeline([["INCR", uses], ["EXPIRE", ...]]);
 *   if (Number(count) > MAX_CLAIM_USES) return { ok: false, reason: "spent" };
 * An INCR reply that is not a number (lost, another shape) is NaN, and `NaN > 10` is false: the emailed link is
 * "still good" however many times it was used. The allowance on a free copy's downloads is not taken on an unknown
 * reply (the delivery's own byte counter, lib/delivery.ts, is exact; this per-link cap is not).
 */
import { createHash } from "node:crypto";
import { MAX_CLAIM_USES, spendClaim } from "@/lib/free";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TOKEN = "c".repeat(64);
const claimKey = `nl:free:claim:${sha(`nimbus-free-claim:${TOKEN}`).slice(0, 40)}`;
const usesKey = `nl:free:uses:${sha(`nimbus-free-uses:${TOKEN}`).slice(0, 40)}`;
const original = redis.pipeline.bind(redis);

async function main() {
  redis.clear();
  await redis.pipeline([["SET", claimKey, JSON.stringify({ h: "shop", p: "p".repeat(32), e: "lead@example.com", c: false, at: "2026-11-06T00:00:00.000Z" })]]);
  part("Healthy control: the link is good MAX_CLAIM_USES times, then spent");
  const answers: string[] = [];
  for (let i = 0; i < MAX_CLAIM_USES + 1; i += 1) { const r = await spendClaim(TOKEN); answers.push(r.ok ? "ok" : r.reason); }
  is(`the ${MAX_CLAIM_USES + 1}th use is refused`, answers.at(-1), "spent");
  is("the stand-in's own count, for the record", (await redis.pipeline([["GET", usesKey]]))[0], String(MAX_CLAIM_USES + 1));

  part("DEFECT: the same spent link, the INCR reply lost or in another shape");
  for (const [label, reply] of [["no reply", () => []], ["QUEUED", () => ["QUEUED", "QUEUED"]], ["null", () => [null, 1]]] as const) {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands[0]?.[0] === "INCR" && String(commands[0][1]).startsWith("nl:free:uses:")) { await original(commands); return reply(); }
      return original(commands);
    }) as typeof redis.pipeline;
    const r = await spendClaim(TOKEN);
    redis.pipeline = original;
    is(`DEFECT (${label}): the spent link is answered good again`, r.ok, true);
  }
  is("while the real count is far past the cap", Number((await redis.pipeline([["GET", usesKey]]))[0]) > MAX_CLAIM_USES, true);
  done();
}
main();
