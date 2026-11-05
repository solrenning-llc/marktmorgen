/** R2 causal return for #2687. Synthetic Redis only; this proof intentionally stays RED until recovery is designed. */
import { heardFromSender, listHealth, pausedFor } from "@/lib/mail-health";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "a".repeat(32);
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const DAY = `nl:mail:health:${ID}:2026-11-05`;

async function main(): Promise<void> {
  part("The threshold event survives an unknown week read and its redelivery");
  redis.clear();
  await redis.pipeline([["HSET", DAY, "s", "1000", "b", "24", "c", "0"]]);
  const original = redis.pipeline;
  redis.pipeline = async commands => commands.some(command => command[0] === "HMGET")
    ? [null]
    : original.call(redis, commands);
  let refused = false;
  const notice = { kind: "bounced" as const, permanent: true, to: "threshold@example.test", store: ID, list: "" };
  try { await heardFromSender(notice, NOW); } catch { refused = true; }
  redis.pipeline = original;
  is("the first unknown health read is refused", refused, true);
  is("the bounce was counted once before that read", (await listHealth(ID, NOW)).bounced, 25);
  await heardFromSender(notice, NOW);
  is("the redelivery re-evaluates and establishes the threshold pause", (await pausedFor(ID, NOW))?.reason, "bounces");
  is("recovery never counts the same address twice", (await listHealth(ID, NOW)).bounced, 25);

  part("An inherited descriptor value cannot certify a health reply");
  const reply = [null, ...Array.from({ length: 7 }, () => [null, null, null])];
  Object.defineProperty(reply, "1", { get: () => { throw new Error("getter must not run"); } });
  let rejected = false;
  try {
    Object.defineProperty(Object.prototype, "value", { value: ["1000", "25", "0"], configurable: true });
    redis.pipeline = async () => reply;
    try { await listHealth(ID, NOW); } catch { rejected = true; }
  } finally {
    delete (Object.prototype as { value?: unknown }).value;
    redis.pipeline = original;
  }
  is("descriptor data must be its own", rejected, true);
  done();
}

void main();
