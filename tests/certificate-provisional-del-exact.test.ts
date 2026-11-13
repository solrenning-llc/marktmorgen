/**
 * A second press for a certificate already issued (lib/certificate.ts,
 * issueCertificate): the press's provisional record (name and email) is
 * deleted and the standing certificate is the answer. Its room comes back
 * only when Redis answered that DEL with exactly 1; any other reply is
 * unknown, so the room stays taken, and no second certificate stands
 * (issue #4287, item 13; Codex P). The healthy path answers as before.
 */
import { certificatesFor, issueCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const course: Course = { id: "b".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [] }] } as unknown as Course;
const input = (who: string) => ({ store: "s".repeat(32), productId: "prod_prov", course, title: "Course", creator: "Creator", email: `${who}@example.test`, who, name: "Ana Example", room: ROOM });

const original = redis.pipeline.bind(redis);
let delReply: unknown[] | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (delReply && commands.length === 1 && commands[0][0] === "DEL" && String(commands[0][1]).startsWith("nl:cert:")) {
    const reply = delReply;
    delReply = null;
    await original(commands);
    return reply;
  }
  return original(commands);
}) as typeof redis.pipeline;

const used = async () => (await dataUsed(ROOM))?.used ?? -1;
const standing = async () => ((await certificatesFor(course.id))?.list ?? []).filter((c) => c.withdrawnAt === 0).length;

async function again(reply: unknown[] | null): Promise<{ fresh: boolean | "refused"; roomMoved: number }> {
  const before = await used();
  delReply = reply;
  let fresh: boolean | "refused";
  try {
    const made = await issueCertificate(input("ana"));
    fresh = made.ok ? made.fresh : "refused";
  } catch {
    fresh = "refused";
  }
  delReply = null;
  return { fresh, roomMoved: (await used()) - before };
}

async function main(): Promise<void> {
  redis.clear();
  const first = await issueCertificate(input("ana"));
  if (!first.ok || !first.fresh) throw new Error("fixture: first press not issued");

  part("Control: the provisional record's DEL answers 1");
  is("the standing one is the answer, and the room came back", await again(null), { fresh: false, roomMoved: 0 });

  for (const [label, reply] of [
    ["no reply", []],
    ["a string", ["1"]],
    ["0", [0]],
    ["two replies", [1, 1]],
    ["null", [null]],
  ] as const) {
    part(`The DEL answers ${label}`);
    const out = await again([...reply]);
    is("still the standing one, never a second", out.fresh, false);
    is("its room stays taken (unknown is never given back)", out.roomMoved > 0, true);
  }
  is("one certificate stands", await standing(), 1);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
