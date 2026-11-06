import { log, setScript } from "@/lib/redis";
import { settleAllPayPal } from "@/lib/paypal-payouts";
async function main() {
  // settleAllPayPal: one store with open batches; the store read times out (throws) -> the store leaves the settling set.
  setScript((c) => { if (c[0][0] === "SMEMBERS") return [["0123456789abcdef0123456789abcdef"]]; if (c[0][0] === "GET") throw new Error("Redis request timed out"); return c.map(() => 1); });
  const done = await settleAllPayPal(Date.now() + 10_000);
  console.log("settleAllPayPal done:", done, "commands:", JSON.stringify(log));
}
main().catch((e) => { console.error("THREW", e); process.exit(1); });
