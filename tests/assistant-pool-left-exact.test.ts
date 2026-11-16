/**
 * Rule 24 in lib/store-assistant.ts assistantLeft (what the studio says the assistant's month has left). A pool
 * whose reply or fields do not read is unknown: it throws UnknownReplyError (the studio then hides the line)
 * instead of reading "held" or "spent" as 0, which said the whole month was still there. A pool not written yet
 * is a fresh month (control), and a pool with numbers reads as before (control).
 */
import { assistantLeft } from "@/lib/store-assistant";
import { assistantWindow } from "@/lib/store-assistant-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const now = Date.now();
const plan = { active: true, period: { start: Math.floor(now / 1000) - 3600, end: Math.floor(now / 1000) + 86_400 } };
const store = { statsId: "statsassist0001", assistantPlan: plan } as never;
const key = `nl:assist:pool:statsassist0001:${assistantWindow(plan as never, now / 1000)!.id}`;
const outcome = async () => {
  try {
    return await assistantLeft(store, now);
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  }
};

async function main(): Promise<void> {
  const fresh = await outcome();
  is("control: a pool not written yet is a fresh month, nothing used", typeof fresh === "object" && fresh !== null && fresh.spentMicroUsd === 0 && fresh.heldMicroUsd === 0 && fresh.left > 0, true);
  redis.run(["HSET", key, "held", "1000", "spent", "2000", "n", "3"]);
  const known = await outcome();
  is("control: numbers read as they are", typeof known === "object" && known !== null ? [known.heldMicroUsd, known.spentMicroUsd, known.answered] : known, [1000, 2000, 3]);
  redis.run(["HSET", key, "spent", "garbage"]);
  is("an unreadable 'spent' is unknown, never 0", await outcome(), "unknown");
  redis.run(["HSET", key, "spent", "2000", "held", "-5"]);
  is("a negative 'held' is unknown, never 0", await outcome(), "unknown");
  redis.run(["HSET", key, "held", "1000", "n", "1.5"]);
  is("a count that is not a whole number is unknown", await outcome(), "unknown");
  done();
}

void main();
