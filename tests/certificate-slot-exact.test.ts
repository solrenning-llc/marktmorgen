/**
 * One certificate per student per course, read exactly (lib/certificate.ts
 * certificateOf and issueCertificate; CX-123 rule 24; audit R41, item 4).
 *
 * What is checked:
 *   - the student's slot is read exactly: a confirmed none (nil) is "no
 *     certificate", an id is read, and any other reply refuses; the issue
 *     path then refuses too, takes back the record it had just written and
 *     gives its room back, and never makes a second standing certificate;
 *   - the same for the record the slot names, and for the claim itself;
 *   - a slot that names a certificate no longer standing is taken only while
 *     it still names that one: a press that took it meanwhile is the answer;
 *   - the healthy and confirmed-empty paths answer as before.
 */
import { UnknownReply } from "@/lib/redis-exact";
import { certificateOf, certificatesFor, certKey, issueCertificate, readCertificate, withdrawCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const course: Course = { id: "a".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [] }] } as unknown as Course;
const slotKey = `nl:course:${course.id}:certs`;
const input = (who: string, name = "Ana Example") => ({ store: "s".repeat(32), productId: "prod_slot", course, title: "Course", creator: "Creator", email: `${who}@example.test`, who, name, room: ROOM });

const original = redis.pipeline.bind(redis);
/** Answers the first command of `name` on `key` (a prefix) with `reply`, everything else as Redis does. */
function answer(name: string, key: string, reply: unknown, once = true): void {
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!(once && used) && commands.length === 1 && commands[0][0] === name && String(commands[0][1]).startsWith(key)) {
      used = true;
      return reply;
    }
    return original(commands);
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = original;
};

async function standing(): Promise<string[]> {
  return ((await certificatesFor(course.id))?.list ?? []).filter((c) => c.withdrawnAt === 0).map((c) => c.email).sort();
}
async function used(): Promise<number> {
  return (await dataUsed(ROOM))?.used ?? -1;
}
async function press(who: string): Promise<{ id: string; fresh: boolean } | "refused"> {
  try {
    const made = await issueCertificate(input(who));
    return made.ok ? { id: made.certificate.id, fresh: made.fresh } : "refused";
  } catch {
    return "refused";
  } finally {
    restore();
  }
}

async function main(): Promise<void> {
  redis.clear();

  part("Healthy and confirmed empty, as before");
  is("no slot: no certificate", await certificateOf(course.id, "ana"), null);
  is("no certificate issued: an empty list", await certificatesFor(course.id), { list: [], total: 0 });
  const first = await press("ana");
  if (first === "refused") throw new Error("first press refused");
  is("issued, fresh", first.fresh, true);
  is("asked again: the same one, not fresh", await press("ana"), { id: first.id, fresh: false });
  is("the slot reads it", (await certificateOf(course.id, "ana"))?.id, first.id);

  part("The slot's read answers in an unknown shape");
  for (const [label, reply] of [
    ["a number", [17]],
    ["an object", [{ id: first.id }]],
    ["true", [true]],
    ["two replies to one command", [first.id, first.id]],
    ["no list at all", null],
  ] as const) {
    const room = await used();
    answer("HGET", slotKey, reply);
    let read: unknown;
    try {
      read = await certificateOf(course.id, "ana");
    } catch (error) {
      read = error instanceof UnknownReply ? "unknown" : "other";
    } finally {
      restore();
    }
    is(`${label}: certificateOf refuses, never "none"`, read, "unknown");
    answer("HGET", slotKey, reply);
    const again = await press("ana");
    is(`${label}: a second press answers the first or refuses`, again === "refused" || again.id === first.id, true);
    is(`${label}: still one standing certificate for the student`, await standing(), ["ana@example.test"]);
    is(`${label}: the slot still names the first`, (await redis.pipeline([["HGET", slotKey, "ana"]]))[0], first.id);
    is(`${label}: the room is back where it was`, await used(), room);
  }

  part("The record the slot names answers in an unknown shape");
  {
    const room = await used();
    answer("GET", certKey(first.id), [17]);
    const again = await press("ana");
    is("refused or the first, never a second standing one", [again === "refused" || again.id === first.id, await standing()], [true, ["ana@example.test"]]);
    is("the room is back where it was", await used(), room);
  }

  part("The claim answers in an unknown shape");
  {
    const room = await used();
    answer("HSETNX", slotKey, [true]);
    is("a claim answered neither 1 nor 0 refuses", await press("bo"), "refused");
    is("its record is taken back and nothing stands for the student", [await standing(), await certificateOf(course.id, "bo")], [["ana@example.test"], null]);
    is("its room given back", await used(), room);
  }

  part("A slot that names a certificate no longer standing");
  const old = await press("cy");
  if (old === "refused") throw new Error("cy refused");
  // The withdrawal's own slot clean-up not made: the slot still names the withdrawn one.
  await redis.pipeline([["SET", certKey(old.id), JSON.stringify({ ...(await readCertificate(old.id)), withdrawnAt: Math.floor(Date.now() / 1000) })]]);
  const renewed = await press("cy");
  is("is taken by a new press, fresh", renewed !== "refused" && renewed.fresh && renewed.id !== old.id, true);
  is("which the slot now names", (await redis.pipeline([["HGET", slotKey, "cy"]]))[0], renewed !== "refused" ? renewed.id : "");
  is("and one stands for the student", (await standing()).filter((e) => e === "cy@example.test").length, 1);

  part("Another press takes that slot meanwhile");
  if (renewed === "refused") throw new Error("renewed refused");
  await redis.pipeline([["SET", certKey(renewed.id), JSON.stringify({ ...(await readCertificate(renewed.id)), withdrawnAt: Math.floor(Date.now() / 1000) })]]);
  let winner = "";
  let raced = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // Right after this press reads the withdrawn record, another press issues and takes the slot.
    const out = await original(commands);
    if (!raced && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === certKey(renewed.id)) {
      raced = true;
      redis.pipeline = original;
      const other = await issueCertificate(input("cy"));
      winner = other.ok ? other.certificate.id : "";
    }
    return out;
  }) as typeof redis.pipeline;
  const late = await press("cy");
  is("the other press made one, fresh", winner !== "" && winner !== renewed.id, true);
  is("the late press answers that one, never writing over it", late !== "refused" && late.id === winner && !late.fresh, true);
  is("the slot names it", (await redis.pipeline([["HGET", slotKey, "cy"]]))[0], winner);
  is("one standing certificate for the student", (await standing()).filter((e) => e === "cy@example.test").length, 1);

  part("Withdrawn the usual way");
  is("withdrawn", await withdrawCertificate(course.id, first.id), true);
  is("the slot is free: no certificate", await certificateOf(course.id, "ana"), null);
  const next = await press("ana");
  is("a new one is issued, fresh", next !== "refused" && next.fresh && next.id !== first.id, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
