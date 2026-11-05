/**
 * A partial Redis week is not a healthy week (CX-123 rule 24).
 *
 * The seven daily HMGET replies are paid reads used to decide whether list
 * email must pause. Every reply has to be present and every counter has to be
 * an exact non-negative whole number. Missing or malformed evidence is
 * unknown, never zero.
 */
import { listHealth } from "@/lib/mail-health";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "a".repeat(32);
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const emptyDay = () => [null, null, null];

async function outcome(reply: unknown): Promise<"accepted" | "unknown"> {
  const original = redis.pipeline;
  try {
    redis.pipeline = async () => reply as unknown[];
    await listHealth(ID, NOW);
    return "accepted";
  } catch {
    return "unknown";
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Only the complete seven-day Redis answer is health evidence");
  is("a short pipeline envelope is unknown", await outcome([null]), "unknown");
  is(
    "a short HMGET day is unknown",
    await outcome([null, ["1000"], ...Array.from({ length: 6 }, emptyDay)]),
    "unknown",
  );
  is(
    "a malformed counter is unknown, never zero",
    await outcome([null, ["1000", "not-a-count", "0"], ...Array.from({ length: 6 }, emptyDay)]),
    "unknown",
  );
  is(
    "the exact reply remains readable",
    await outcome([null, ["1000", "25", "1"], ...Array.from({ length: 6 }, emptyDay)]),
    "accepted",
  );
  done();
}

void main();
