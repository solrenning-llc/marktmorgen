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
      const offset = 3+Number(c[2]), k = c.slice(3, offset).map(String);
      const op = String(c[offset]), expected = String(c[offset+1]), supplied = String(c[offset+2]);
      const now = Number(c[offset+3]), owner = String(c[offset+6]);
      const policy = JSON.parse(String(c[offset+5])) as ShipmentMailPolicy | null;
      const raw = store.run(["GET", k[0]]) as string | null;
      const source = store.run(["GET", k[1]]) as string | null;
      let answer: unknown;
      if (op === "enqueue") {
        if (raw) answer = ["existing", raw, source ?? ""];
        else if (source) answer = ["legacy", source];
        else {
          const value = JSON.parse(supplied);
          if(value.originKind==="single_digital_renewal") {
            const pending=store.run(["GET",k[10]]);
            if(pending){answers.push(["duplicate",pending]);continue;}
            if(Number(store.run(["SCARD",k[11]]))>=8){answers.push(["full"]);continue;}
            store.run(["SET",k[10],value.id]);store.run(["SADD",k[11],value.id]);
          }
          store.run(["SET", k[0], supplied]); store.run(["SET", k[1], value.sourceValue]);
          if(value.originKind!=="course")store.run(["ZADD", k[2], now, value.id]);
          for (const index of [3, 4, 7]) store.run(["SADD", k[index], value.id]);
          answer = ["queued", supplied];
        }
      } else if (!raw) answer = ["missing"];
      else if (raw !== expected) answer = ["changed"];
      else {
        const value = JSON.parse(raw);
        if (op === "accepted" || op === "cancel") {
          if(value.originKind==="single_digital_renewal"){store.run(["DEL",k[10]]);store.run(["SREM",k[11],value.id]);}
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
