/**
 * A certificate whose course indexes could not be written is put on them by the student's next press (#4277;
 * Codex P's hidden #4230, re-framed and transcribed by Claude 1).
 *
 * issueCertificate (lib/certificate.ts) writes the record, claims the student's slot, then adds the certificate to
 * the course's two indexes (certs:all, certs:by:<who>) in a separate step. When that step timed out, the record and
 * the slot stood, and every later press answered the standing certificate (fresh: false) without writing the
 * indexes, so the creator's list (certificatesFor) and the course counts never showed it. Now a press that finds
 * the standing certificate also adds it to both indexes (SADD is idempotent), each reply read as 0 or 1.
 *
 * Synthetic course and students, in-memory Redis; nothing real is reached.
 */
import { certificatesFor, issueCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const original = redis.pipeline.bind(redis);
let failIndexOnce = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (failIndexOnce && commands.some((c) => c[0] === "SADD" && String(c[1]).endsWith(":certs:all"))) {
    failIndexOnce = false;
    throw new Error("synthetic: Redis request timed out");
  }
  return original(commands);
}) as typeof redis.pipeline;

const lesson = { id: "lesson000001", title: "One", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null } as unknown as Course["modules"][number]["lessons"][number];
const course: Course = { id: "d".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [lesson] }] } as Course;
const input = (who: string) => ({ store: "storekey01", productId: "prod01", course, title: "Bookkeeping Basics", creator: "Night School", email: `${who}@example.com`, who, name: "Ana Lopes", room: ROOM });

async function main(): Promise<void> {
  redis.clear();
  part("Control: a certificate issued with Redis well is on the creator's list");
  const control = await issueCertificate(input("eli"));
  is("listed", (await certificatesFor(course.id))?.list.map((c) => c.id), [control.ok ? control.certificate.id : ""]);

  part("The index write times out once, after the slot was claimed");
  failIndexOnce = true;
  const first = await issueCertificate(input("ana")).then(() => "returned", (error: unknown) => `threw ${error instanceof Error ? error.message : error}`);
  is("the press fails", first, "threw synthetic: Redis request timed out");
  const again = await issueCertificate(input("ana"));
  is("the student's next press answers the standing certificate", again.ok && again.fresh, false);
  const listed = (await certificatesFor(course.id))?.list.map((c) => c.id) ?? [];
  is("and the creator's list shows it", listed.includes(again.ok ? again.certificate.id : "?"), true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
