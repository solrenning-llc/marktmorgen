/**
 * Issue #4287, item 13 (Codex P, `P-20261112-2137-certificate-provisional-delete.md`; rule 24): when a press finds the
 * student's standing certificate, issueCertificate (lib/certificate.ts) deletes the record this press wrote and gives
 * its room back. The DEL's reply was not read, so the room came back whatever Redis answered: a record that may still
 * be kept stopped counting in the store's data room. Now the reply is read exactly: 1 gives the room back, 0 keeps it
 * counted, and any other answer throws UnknownReply with the room left as it was.
 *
 * Synthetic course and students, in-memory Redis; nothing real is reached.
 */
import { issueCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const original = redis.pipeline.bind(redis);
/** What the next DEL of a certificate record answers instead of Redis, once. */
let delAnswer: unknown = undefined;
/** The data-room scripts sent after that DEL. */
let roomAfterDel = 0;
let delSeen = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const del = commands.length === 1 && commands[0]![0] === "DEL" && String(commands[0]![1]).includes(":cert:");
  if (del && delAnswer !== undefined) {
    const answer = delAnswer;
    delAnswer = undefined;
    delSeen = true;
    await original(commands);
    return [answer];
  }
  if (delSeen && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:"))) roomAfterDel += 1;
  return original(commands);
}) as typeof redis.pipeline;

const lesson = { id: "lesson000001", title: "One", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null } as unknown as Course["modules"][number]["lessons"][number];
const course: Course = { id: "e".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [lesson] }] } as Course;
const input = (who: string) => ({ store: "storekey02", productId: "prod02", course, title: "Bookkeeping Basics", creator: "Night School", email: `${who}@example.com`, who, name: "Ana Lopes", room: ROOM });

async function press(who: string, answer: unknown): Promise<string> {
  delAnswer = answer;
  delSeen = false;
  roomAfterDel = 0;
  return issueCertificate(input(who)).then(
    (result) => (result.ok ? `standing ${result.fresh}` : `refused ${result.reason}`),
    (error: unknown) => `threw ${error instanceof Error ? error.name : String(error)}`,
  );
}

async function main(): Promise<void> {
  redis.clear();
  const first = await issueCertificate(input("ana"));
  is("the first press issues a certificate", first.ok && first.fresh, true);

  part("The provisional DEL answers 1: the room comes back, the standing certificate is the answer");
  is("answered", await press("ana", 1), "standing false");
  is("its room given back once", roomAfterDel, 1);

  part("Any other answer is unknown: the press fails and the room stays counted");
  for (const [label, answer] of [["text '1'", "1"], ["a list", [1]], ["nothing", null], ["two", 2]] as const) {
    is(`${label}: the press fails as unknown`, await press("ana", answer), "threw UnknownReply");
    is(`${label}: no room given back`, roomAfterDel, 0);
  }

  part("0 (the record was already gone): the room is not given back twice, the standing one is the answer");
  is("answered", await press("ana", 0), "standing false");
  is("no room given back", roomAfterDel, 0);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
