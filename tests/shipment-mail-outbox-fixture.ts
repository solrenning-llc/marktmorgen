/** Synthetic ACK/transport boundary for orchestration tests, not a Lua
 * emulator or financial review. The application Lua runs separately against
 * real Redis in scripts/test_shipment_mail_outbox_redis.py.
 */
import { store } from "./redis-stub";
import { SHIPMENT_MAIL_SCRIPT, type ShipmentMailPolicy, type ShipmentMailPipeline } from "@/lib/shipment-mail-outbox";

export const shipmentPolicy = (now = Date.now()): ShipmentMailPolicy => ({
  reviewId: "SYNTHETIC_SHIPMENT_ONLY", evidence: "SYNTHETIC; no live funding or account",
  ongoingStorageFunded: true, emptyInitializationVerified: true, globalItems: 100,
  globalBytes: 10_000_000, storeItems: 100, storeBytes: 10_000_000,
  maxPayloadBytes: 60_000, maximumChecks: 100, retryMilliseconds: 60_000,
  admissionsUntil: now + 86_400_000,
});

export function shipmentOutboxFixture() {
  const base = store.pipeline.bind(store);
  const commands: (string | number)[][] = [];
  let lose: string | null = null;
  const pipeline: ShipmentMailPipeline = async (batch) => {
    const answers: unknown[] = [];
    for (const c of batch) {
      commands.push([...c]);
      if (c[0] !== "EVAL" || c[1] !== SHIPMENT_MAIL_SCRIPT) {
        answers.push(...await base([c])); continue;
      }
      const k = c.slice(3, 13).map(String);
      const op = String(c[13]), expected = String(c[14]), supplied = String(c[15]);
      const now = Number(c[16]), owner = String(c[19]);
      const policy = JSON.parse(String(c[18])) as ShipmentMailPolicy | null;
      const raw = store.run(["GET", k[0]]) as string | null;
      const source = store.run(["GET", k[1]]) as string | null;
      let answer: unknown;
      if (op === "enqueue") {
        if (raw) answer = ["existing", raw, source ?? ""];
        else if (source) answer = ["legacy", source];
        else {
          const value = JSON.parse(supplied);
          store.run(["SET", k[0], supplied]); store.run(["SET", k[1], value.sourceValue]);
          store.run(["ZADD", k[2], now, value.id]);
          for (const index of [3, 4, 7]) store.run(["SADD", k[index], value.id]);
          answer = ["queued", supplied];
        }
      } else if (!raw) answer = ["missing"];
      else if (raw !== expected) answer = ["changed"];
      else {
        const value = JSON.parse(raw);
        if (op === "accepted" || op === "cancel") {
          store.run(["DEL", k[0]]); store.run(["ZREM", k[2], value.id]);
          for (const index of [3, 4, 7]) store.run(["SREM", k[index], value.id]);
          store.run(["EXPIRE", k[1], 400 * 86_400]);
          answer = [op === "accepted" ? "accepted" : "canceled"];
        } else if (op === "claim" && value.state !== "queued" && !(value.state === "preparing" && value.leaseUntil <= now)) answer = ["held", raw];
        else if (op === "claim") {
          value.state = "preparing"; value.owner = owner; value.leaseUntil = now + 60_000;
          value.next = value.leaseUntil; value.checks++;
          const next = JSON.stringify(value); store.run(["SET", k[0], next]);
          store.run(["ZADD", k[2], value.next, value.id]); answer = ["preparing", next];
        } else if (value.owner !== owner) answer = ["held", raw];
        else {
          value.state = op === "dispatch" ? "dispatching" : op === "refused" ? "refused" : "queued";
          value.leaseUntil = 0;
          value.next = value.state === "queued" ? now + policy!.retryMilliseconds : 0;
          const next = JSON.stringify(value); store.run(["SET", k[0], next]);
          if (value.next) store.run(["ZADD", k[2], value.next, value.id]); else store.run(["ZREM", k[2], value.id]);
          answer = [value.state, next];
        }
      }
      if (op === lose) { lose = null; throw Error("synthetic committed operation with lost ACK"); }
      answers.push(answer);
    }
    return answers;
  };
  return { pipeline, commands, loseNext: (op: string) => { lose = op; } };
}
