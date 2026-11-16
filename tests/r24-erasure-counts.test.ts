/**
 * Rule 24 in the erasure steps (CX-123; the coordinator's sweep of `Number(x) || 0`, 16 November 2026).
 *
 * Each step of a person's erasure (lib/person-erasure.ts) and of a member's community erasure
 * (lib/community-erasure.ts) answers how many records it removed, and a step that throws marks the erasure
 * "incomplete", so it is pressed again. Eight steps read their DEL, HDEL or ZREM reply as `Number(x) || 0`: an answer
 * that is not a count (none, an error, text, a queued envelope) read as "0 removed", the step counted as done, and the
 * erasure said complete while the records may still be there. forgetRsvpsPerson read its events index the same way:
 * an index that did not read was "no events", so nothing was removed at all.
 *
 * What fails here: a step that answers a number when its reply is not one; a step that does not answer the real count
 * when it is.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts).
 */
import { forgetNotesPerson } from "@/lib/buyer-profile";
import { forgetFeedCopyPerson } from "@/lib/calendar-sync";
import { forgetGrantPerson } from "@/lib/chat-grant";
import { forgetAccessPerson } from "@/lib/community-access";
import { forgetRsvpsPerson } from "@/lib/community-events";
import { forgetPointsPerson } from "@/lib/community-points";
import { forgetVoicePerson } from "@/lib/customer-voice";
import { forgetHealthPerson } from "@/lib/mail-health";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
let answer: ((commands: Cmd[]) => unknown[]) | null = null;
redis.pipeline = (async (commands: Cmd[]) => (answer ? answer(commands) : original(commands))) as typeof redis.pipeline;

const ID = "a".repeat(32);
const WHO = "b".repeat(32);
const STATS = "c".repeat(32);
const EMAIL = "gone@example.com";
const STORE = { sid: "d".repeat(32), listId: "e".repeat(32) } as const;

const steps: [string, () => Promise<number>][] = [
  ["forgetNotesPerson", () => forgetNotesPerson(STATS, WHO)],
  ["forgetFeedCopyPerson", () => forgetFeedCopyPerson(STATS)],
  ["forgetGrantPerson", () => forgetGrantPerson(ID, WHO)],
  ["forgetAccessPerson", () => forgetAccessPerson(ID, EMAIL, ["f".repeat(32)], ["prod00000001"])],
  ["forgetRsvpsPerson", () => forgetRsvpsPerson(ID, WHO, EMAIL)],
  ["forgetPointsPerson", () => forgetPointsPerson(ID, WHO)],
  ["forgetVoicePerson", () => forgetVoicePerson(STATS)],
  ["forgetHealthPerson", () => forgetHealthPerson(STORE, EMAIL)],
];

/** What a step answers: its count, or "unknown" when it throws. */
const outcome = async (run: () => Promise<number>) => {
  try {
    return await run();
  } catch {
    return "unknown";
  }
};

/** A reply of the right length whose every slot is not a count. */
const garbled = (slot: unknown) => (commands: Cmd[]) => commands.map(() => slot);

async function main(): Promise<void> {
  for (const [name, run] of steps) {
    part(name);
    for (const [what, reply] of [
      ["no reply at all", () => [] as unknown[]],
      ["a queued envelope", garbled("QUEUED")],
      ["an error in place of a count", garbled(new Error("TEST: Redis error"))],
      ["text in place of a count", garbled("many")],
    ] as [string, (commands: Cmd[]) => unknown[]][]) {
      redis.clear();
      answer = (commands) => {
        // The events index of forgetRsvpsPerson is answered, so the step reaches its deletes.
        if (commands.length === 1 && commands[0][0] === "ZRANGEBYSCORE") return [["event0000001"]];
        return reply(commands);
      };
      is(`${what}: unknown, never a count`, await outcome(run), "unknown");
      answer = null;
    }
  }

  part("forgetRsvpsPerson: an events index that does not read is unknown, never no events");
  redis.clear();
  answer = (commands) => (commands[0][0] === "ZRANGEBYSCORE" ? ["QUEUED"] : original(commands) as never);
  is("the step throws, so the erasure is pressed again", await outcome(() => forgetRsvpsPerson(ID, WHO, EMAIL)), "unknown");
  answer = null;

  part("Control: real replies still give the real counts");
  redis.clear();
  await original([["SET", `nl:cm:${ID}:rg:${WHO}`, "1"], ["SET", `nl:cal:out:${STATS}`, "x"]]);
  is("forgetGrantPerson removes the one key", await outcome(() => forgetGrantPerson(ID, WHO)), 1);
  is("and nothing the second time", await outcome(() => forgetGrantPerson(ID, WHO)), 0);
  is("forgetFeedCopyPerson removes the one key", await outcome(() => forgetFeedCopyPerson(STATS)), 1);
  is("forgetNotesPerson with nothing kept: 0", await outcome(() => forgetNotesPerson(STATS, WHO)), 0);
  is("forgetRsvpsPerson with no events: 0", await outcome(() => forgetRsvpsPerson(ID, WHO, EMAIL)), 0);
  is("forgetPointsPerson with nothing kept: 0", await outcome(() => forgetPointsPerson(ID, WHO)), 0);
  is("forgetHealthPerson with nothing kept: 0", await outcome(() => forgetHealthPerson(STORE, EMAIL)), 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
