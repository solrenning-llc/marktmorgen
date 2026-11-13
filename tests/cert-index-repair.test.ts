/**
 * #4277 (Codex P #4230): issueCertificate wrote the course's two indexes (SADD certs:all, SADD certs:by:<who>) only
 * after the student's slot was claimed, in a separate pipeline. A timeout there left the record and the slot
 * standing, and every later press answered `fresh: false` without writing the indexes, so the creator's list
 * (certificatesFor) and the course count (certificateCount) never showed it. A later press now puts the standing
 * certificate back on both indexes (SADD is idempotent) and reads their replies exactly. Synthetic only (in-memory Redis).
 */
import { certificateCount, certificatesFor, issueCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const original = redis.pipeline.bind(redis);
let failIndexOnce = false;
let oddIndexReply = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const index = commands.some((c) => c[0] === "SADD" && String(c[1]).endsWith(":certs:all"));
  if (failIndexOnce && index) {
    failIndexOnce = false;
    throw new Error("synthetic: Redis request timed out");
  }
  if (oddIndexReply && index) {
    oddIndexReply = false;
    await original(commands);
    return ["OK", "OK"];
  }
  return original(commands);
}) as typeof redis.pipeline;

const lesson = { id: "lesson000001", title: "One", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null } as unknown as Course["modules"][number]["lessons"][number];
const course: Course = { id: "d".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [lesson] }] } as Course;
const input = (who: string) => ({ store: "storekey01", productId: "prod01", course, title: "Bookkeeping Basics", creator: "Night School", email: `${who}@example.com`, who, name: "Ana Lopes", room: ROOM });
const listed = async () => (await certificatesFor(course.id))?.list.map((c) => c.id) ?? [];

async function main(): Promise<void> {
  redis.clear();
  part("(control) a certificate issued with Redis well is on the creator's list");
  const control = await issueCertificate(input("eli"));
  is("listed", await listed(), [control.ok ? control.certificate.id : ""]);
  const again0 = await issueCertificate(input("eli"));
  is("(control) a second press answers the same certificate", again0.ok && again0.certificate.id, control.ok && control.certificate.id);
  is("(control) and it is listed once", await listed(), [control.ok ? control.certificate.id : ""]);

  part("the index write times out once, after the slot was claimed");
  failIndexOnce = true;
  const first = await issueCertificate(input("ana")).then(() => "returned", (error: unknown) => `threw ${error instanceof Error ? error.message : error}`);
  is("the press fails", first, "threw synthetic: Redis request timed out");
  const again = await issueCertificate(input("ana"));
  is("the student's next press answers the standing certificate", again.ok && again.fresh, false);
  const id = again.ok ? again.certificate.id : "?";
  is("and the creator's list shows it", (await listed()).includes(id), true);
  is("the course count includes it", await certificateCount([course.id]), 2);
  is("the student's own index holds it", redis.run(["SISMEMBER", `nl:course:${course.id}:certs:by:ana`, id]), 1);

  part("an index reply that is not 0 or 1 is not taken as written");
  const third = await (async () => { oddIndexReply = true; return issueCertificate(input("bo")).then(() => "returned", (error: unknown) => `threw ${error instanceof Error ? error.name : error}`); })();
  is("the press is refused as unknown", third, "threw UnknownReply");
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
