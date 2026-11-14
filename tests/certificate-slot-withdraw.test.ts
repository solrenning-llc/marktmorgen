/**
 * A withdrawal frees the student's slot only while it still names the
 * certificate withdrawn (lib/certificate.ts withdrawCertificate; CX-123 rules
 * 24 and 25; review of #3374).
 *
 * What is checked:
 *   - a press that lands just before the withdrawal frees the slot keeps the
 *     certificate it issued: the slot still names it, certificateOf answers
 *     it, and the next press answers it instead of issuing another;
 *   - the step that frees the slot is read exactly: 1 and 0 are known, any
 *     other reply refuses (UnknownReply), never reported as done, and a retry
 *     frees the slot;
 *   - the healthy paths answer as before: the slot freed, a new press fresh,
 *     and an older certificate withdrawn without touching the slot that names
 *     a newer one.
 */
import { UnknownReply } from "@/lib/redis-exact";
import { certificateOf, certificatesFor, issueCertificate, withdrawCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const course: Course = { id: "b".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [] }] } as unknown as Course;
const slotKey = `nl:course:${course.id}:certs`;
/** The student as the withdrawal finds them: their slot is the key of their address (lib/learn.ts emailKey). */
const key = (who: string) => emailKey(`${who}@example.test`);
const input = (who: string) => ({ store: "s".repeat(32), productId: "prod_slot", course, title: "Course", creator: "Creator", email: `${who}@example.test`, who: key(who), name: "Ana Example", room: ROOM });

const original = redis.pipeline.bind(redis);
const restore = () => {
  redis.pipeline = original;
};
/** Whether one command writes the student's slot: an HDEL of it, or a script given it as its key. */
const writesSlot = (command: (string | number)[]) =>
  (command[0] === "HDEL" && command[1] === slotKey) || (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:cert-slot-") && command[3] === slotKey);

async function issue(who: string): Promise<string> {
  const made = await issueCertificate(input(who));
  if (!made.ok) throw new Error(`${who}: refused`);
  return made.certificate.id;
}
async function slot(who: string): Promise<unknown> {
  return (await original([["HGET", slotKey, key(who)]]))[0];
}
async function standing(who: string): Promise<string[]> {
  return ((await certificatesFor(course.id))?.list ?? []).filter((c) => c.withdrawnAt === 0 && c.email === `${who}@example.test`).map((c) => c.id);
}
async function withdraw(id: string): Promise<boolean | "unknown" | "other"> {
  try {
    return await withdrawCertificate(course.id, id);
  } catch (error) {
    return error instanceof UnknownReply ? "unknown" : "other";
  } finally {
    restore();
  }
}

async function main(): Promise<void> {
  redis.clear();

  part("Healthy, as before");
  const first = await issue("ana");
  is("withdrawn", await withdraw(first), true);
  is("the slot is free", await slot("ana"), null);
  is("no certificate for the student", await certificateOf(course.id, key("ana")), null);
  const second = await issue("ana");
  is("a new press is fresh", second !== first, true);
  is("the slot names it", await slot("ana"), second);
  is("withdrawing the older one again: known, done", await withdraw(first), true);
  is("the slot that names the newer one is kept", await slot("ana"), second);
  is("the newer one still stands", await standing("ana"), [second]);

  part("A press lands just before the withdrawal frees the slot");
  const old = await issue("bo");
  let other = "";
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!other && commands.length === 1 && writesSlot(commands[0])) {
      // The record is already marked withdrawn: another press takes the slot for a new one now.
      redis.pipeline = original;
      other = await issue("bo");
    }
    return original(commands);
  }) as typeof redis.pipeline;
  is("the withdrawal is done", await withdraw(old), true);
  is("the other press made a new one", other !== "" && other !== old, true);
  is("the slot still names the new one", await slot("bo"), other);
  is("certificateOf answers the new one", (await certificateOf(course.id, key("bo")))?.id, other);
  const after = await issueCertificate(input("bo"));
  is("the next press answers the new one, not fresh", after.ok && after.certificate.id === other && !after.fresh, true);
  is("one standing certificate for the student", await standing("bo"), [other]);

  part("The step that frees the slot answers in an unknown shape");
  for (const [label, reply] of [
    ["a 2", [2]],
    ["the text 1", ["1"]],
    ["true", [true]],
    ["nil", [null]],
    ["a list", [[1]]],
    ["two replies to one command", [1, 1]],
    ["no list at all", null],
  ] as const) {
    const id = await issue("cy");
    let seen = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!seen && commands.length === 1 && writesSlot(commands[0])) {
        seen = true;
        return reply;
      }
      return original(commands);
    }) as typeof redis.pipeline;
    is(`${label}: refused, never reported as done`, await withdraw(id), "unknown");
    is(`${label}: the step was asked`, seen, true);
    is(`${label}: a retry withdraws it`, await withdraw(id), true);
    is(`${label}: and frees the slot`, await slot("cy"), null);
  }

  part("The step that frees the slot answers 0: known, nothing removed");
  {
    const id = await issue("di");
    let seen = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!seen && commands.length === 1 && writesSlot(commands[0])) {
        seen = true;
        return [0];
      }
      return original(commands);
    }) as typeof redis.pipeline;
    is("done", await withdraw(id), true);
    is("the step was asked", seen, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
