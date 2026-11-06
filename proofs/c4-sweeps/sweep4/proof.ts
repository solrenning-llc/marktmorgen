import { log, setScript } from "@/lib/redis";
import { setTestCode } from "@/lib/ad-events";
import { forgetTasksPerson } from "@/lib/assignment";
import { watchPayPal, readPaid, stillPending } from "@/lib/paypal-sales";

async function main() {
  // 1. ad-events: read of the config answers with no `result` (undefined) -> stored = {} -> SET overwrites every token.
  log.length = 0;
  setScript((c) => c.map((cmd) => (cmd[0] === "GET" ? undefined : "OK")));
  await setTestCode("statsabc", "TEST123");
  console.log("1 ad-events setTestCode writes:", JSON.stringify(log.filter((c) => c[0] === "SET")));

  // 2. assignment: erasure, GET reply short (pipeline answered []) -> records 0, nothing deleted.
  log.length = 0;
  setScript(() => []);
  const done = await forgetTasksPerson("course1", ["lesson1"], "0123456789abcdef", "room");
  console.log("2 forgetTasksPerson:", JSON.stringify(done), "DELs sent:", log.filter((c) => c[0] === "DEL").length);

  // 3. paypal-sales watch: pending order whose GET answers undefined -> ZREM from pending, PayPal never asked.
  process.env.PAYPAL_PARTNER_CLIENT_ID = "c"; process.env.PAYPAL_PARTNER_SECRET = "s"; process.env.PAYPAL_PARTNER_MERCHANT_ID = "ABCDEFGHIJKLM"; process.env.PAYPAL_BN_CODE = "b";
  log.length = 0;
  let fetched = 0; (globalThis as any).fetch = async () => { fetched += 1; throw new Error("no network"); };
  setScript((c) => c.map((cmd) => (cmd[0] === "ZRANGEBYSCORE" && String(cmd[1]).includes("pending") ? ["ORDER12345AB"] : cmd[0] === "ZRANGEBYSCORE" ? [] : cmd[0] === "GET" ? undefined : 1)));
  await watchPayPal({ statsId: "statsabc", paypalSeller: { merchant: "MERCH" } } as any, Date.now() + 10_000, { handOver: async () => {}, dropStart: async () => {} });
  console.log("3 watchPayPal commands:", JSON.stringify(log.map((c) => c.slice(0, 3))), "PayPal calls:", fetched);

  // 4. thanks page inputs: readPaid / stillPending on a malformed reply.
  setScript(() => []);
  console.log("4 readPaid:", await readPaid("ORDER12345AB"), "stillPending:", await stillPending({ statsId: "statsabc" } as any, "ORDER12345AB"));
}
main().catch((e) => { console.error("THREW", e); process.exit(1); });
