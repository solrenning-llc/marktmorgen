/** Independent receipt-boundary controls; transport stand-in, not Lua evidence. */
import { enqueueShipmentMail, runShipmentMail, type ShipmentMailPipeline } from "@/lib/shipment-mail-outbox";
import { shipmentOutboxFixture, shipmentPolicy } from "./shipment-mail-outbox-fixture";
import { store } from "./redis-stub";
import { is, done } from "./check";

async function main() {
  const now = 1800000000000;
  const input = { statsId: "g_receipts", session: "cs_test_greceipts0000001", authorizedAt: now,
    shipped: { at: now / 1000, tracking: "" }, message: { from: "sender@example.test", to: "buyer@example.test", subject: "Synthetic", text: "Synthetic", replyTo: "sender@example.test" } };
  for (const stage of ["claim", "dispatch"] as const) {
    for (const field of ["sealed", "fingerprint", "bytes", "created", "authorizedAt", "sourceValue", "person", "checks", "leaseUntil", "reviewId"]) {
      store.clear(); const world = shipmentOutboxFixture();
      const pipeline: ShipmentMailPipeline = async commands => {
        const reply = await world.pipeline(commands);
        if (commands.some(c => c[0] === "EVAL" && c[13] === stage)) {
          const tuple = reply[0] as unknown[], row = JSON.parse(String(tuple[1]));
          row[field] = typeof row[field] === "number" ? row[field] + 1 : row[field] + "x";
          return [[tuple[0], JSON.stringify(row)]];
        }
        return reply;
      };
      const runtime = { lifecycle: "active" as const, policy: shipmentPolicy(now), pipeline, now: () => now };
      if (!(await enqueueShipmentMail(input, runtime)).ok) throw Error("control enqueue");
      let posts = 0;
      const result = await runShipmentMail(now + 20000, async (_m, beforePost) => { if (await beforePost()) posts++; return "unknown"; }, runtime);
      is(`${stage} altered ${field} authorizes no POST`, posts, 0);
      is(`${stage} altered ${field} remains unknown`, result, { accepted: 0, waiting: 0, unknown: 1 });
    }
  }
  for (const stage of ["defer", "not-accepted"] as const) {
    store.clear(); const world = shipmentOutboxFixture();
    const pipeline: ShipmentMailPipeline = async commands => {
      const reply = await world.pipeline(commands);
      return commands.some(c => c[0] === "EVAL" && c[13] === stage) ? [["queued"]] : reply;
    };
    const runtime = { lifecycle: "active" as const, policy: shipmentPolicy(now), pipeline, now: () => now };
    if (!(await enqueueShipmentMail(input, runtime)).ok) throw Error("control enqueue");
    const result = await runShipmentMail(now + 20000, async (_m, beforePost) => {
      if (stage === "defer") return "waiting";
      if (!await beforePost()) throw Error("control barrier");
      return "not_accepted";
    }, runtime);
    is(`${stage} short receipt cannot certify waiting`, result, { accepted: 0, waiting: 0, unknown: 1 });
  }
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
