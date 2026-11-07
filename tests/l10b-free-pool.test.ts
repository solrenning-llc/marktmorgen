/**
 * CX-123 rule 24, lot L10b: a store that pays nothing takes one of the month's places (lib/free-pool.ts) with a SET NX
 * of "1" (a place) or "0" (turned away for an hour). A reply to it in any shape but "OK" or nil is read back: the key
 * holding what this request decided stands; holding the other answer, written a moment earlier by another request,
 * that answer stands; nothing readable is "unknown", so nothing the store would do is let through and charged to us.
 */
import { createHash } from "node:crypto";
import { calendarWindow } from "@/lib/allowance-window";
import { poolPlace } from "@/lib/free-pool";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ODD, THROWS, UNREADABLE, answer, clearAnswers, getOf, setNx } from "./l10b-replies";

const free = (n: number) => ({ sid: `l10b${String(n).padStart(3, "0")}`.padEnd(32, "p"), handle: `lpool${n}`, statsId: null, tier: "creator" as const, subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "" });
const IN = "nl:free:in:";

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  const month = calendarWindow(now).id;
  let n = 0;

  part("The plain case: a place");
  is("a store that pays nothing takes a free place", await poolPlace(free((n += 1)), now), "in");

  part("Turned away a moment ago by another request: that answer stands");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    redis.run(["DEL", `nl:free:n:${month}`]);
    const store = free((n += 1));
    // Between this request's read and its write, another request turned the store away.
    answer(setNx(IN), reply, { before: () => void redis.run(["SET", `${IN}${month}:${idOf(store.sid)}`, "0", "EX", 3_600]) });
    is(`the place answered with ${shape} while "0" is held: full, not let through`, await poolPlace(store, now), "full");
  }

  part("The place written and its answer lost: what this request decided, read back");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    redis.run(["DEL", `nl:free:n:${month}`]);
    answer(setNx(IN), reply);
    is(`answered with ${shape}, the write landed: in`, await poolPlace(free((n += 1)), now), "in");
  }

  part("Nothing readable: unknown, never let through");
  for (const [shape, reply] of [...UNREADABLE, ["the write failing too", THROWS] as const]) {
    clearAnswers();
    redis.run(["DEL", `nl:free:n:${month}`]);
    answer(setNx(IN), shape === "the write failing too" ? THROWS : () => ["QUEUED"], { run: false });
    answer(getOf(IN), reply);
    is(`the place unknown and its read-back ${shape}: unknown`, await poolPlace(free((n += 1)), now), "unknown");
  }
  clearAnswers();
  done();
}

/** lib/free-pool.ts idOf, for a store counted by its id. */
function idOf(sid: string): string {
  return createHash("sha256").update(`free-pool:${sid}`).digest("hex").slice(0, 32);
}

void main();
