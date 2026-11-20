/**
 * Earning and withdrawing a certificate of completion (lib/certificate.ts,
 * hasFinished, issueCertificate, withdrawCertificate; ClickFunnels audit F36,
 * added 17 October 2026). tests/certificate-pdf.test.ts and
 * tests/certificate-share.test.ts cover the file and the LinkedIn links;
 * this covers who gets one:
 *
 *   - finished means every lesson done and every quiz that must be passed
 *     passed; a course with no lessons is never finished;
 *   - the name is the one typed, cleaned of control and direction characters,
 *     two to eighty letters;
 *   - one standing certificate per student per course: asking again answers
 *     the same one, and two presses at the same moment make one — the defect
 *     found here: the slot was claimed before the record existed, so a second
 *     press in that moment read it as lost and issued a second certificate;
 *   - withdrawn, its page says so, it is no longer the student's, and the
 *     student may be issued a new one; a certificate of another course is
 *     not withdrawn through this one.
 */
import { certificateOf, certificatesFor, cleanName, hasFinished, issueCertificate, readCertificate, withdrawCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const lesson = (id: string, quiz: { required: boolean } | null = null) => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: false, quiz: quiz ? { questions: 3, pass: 2, tries: 3, required: quiz.required } : null }) as unknown as Course["modules"][number]["lessons"][number];
const course: Course = {
  id: "c".repeat(32),
  certificate: true,
  startsAt: null,
  modules: [
    { id: "module000001", title: "One", dripDays: 0, lessons: [lesson("lesson000001"), lesson("lesson000002", { required: true })] },
    { id: "module000002", title: "Two", dripDays: 0, lessons: [lesson("lesson000003", { required: false })] },
  ],
};

async function main(): Promise<void> {
  redis.clear();

  part("Finished");
  const all = new Set(["lesson000001", "lesson000002", "lesson000003"]);
  is("a course with no lessons is never finished", hasFinished({ ...course, modules: [] }, new Set(), new Set()), false);
  is("a lesson not done: not finished", hasFinished(course, new Set(["lesson000001", "lesson000002"]), new Set(["lesson000002"])), false);
  is("every lesson done, the required quiz not passed: not finished", hasFinished(course, all, new Set()), false);
  is("every lesson done and the required quiz passed: finished, the optional quiz aside", hasFinished(course, all, new Set(["lesson000002"])), true);

  part("The name on it");
  is("as typed, its spaces tidied", cleanName("  Ana   María  Lopes "), "Ana María Lopes");
  is("control and direction characters are taken out", cleanName("Ana‮\u0007Lopes"), "Ana Lopes");
  is("one letter, or more than eighty, is not a name", [cleanName("A"), cleanName("x".repeat(81)), cleanName(42)], [null, null, null]);

  part("One per student per course");
  const input = (who: string, name: unknown = "Ana Lopes") => ({ store: "storekey01", productId: "prod01", course, title: "Bookkeeping Basics", creator: "Night School", email: `${who}@example.com`, who, name, room: ROOM });
  const first = await issueCertificate(input("ana"));
  is("issued, fresh", first.ok && first.fresh, true);
  const again = await issueCertificate(input("ana", "Another Name"));
  is("asked again: the same one, under the name it was issued with", again.ok ? [again.fresh, again.certificate.id === (first.ok ? first.certificate.id : ""), again.certificate.name] : again, [false, true, "Ana Lopes"]);
  is("a bad name is refused before anything is written", await issueCertificate(input("ben", "B")), { ok: false, reason: "name" });
  // A real database answers each request in its own time: the write of a
  // certificate's record is made to arrive late, as it can between two presses.
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:cert:"))) await new Promise((resolve) => setTimeout(resolve, 30));
    return original(commands);
  };
  const both = await Promise.all([issueCertificate(input("cy", "Cy Park")), issueCertificate(input("cy", "Cy Park"))]);
  redis.pipeline = original;
  const ids = both.map((r) => (r.ok ? r.certificate.id : ""));
  is("two presses at the same moment: one certificate, the same answer to both", [ids[0] === ids[1], both.filter((r) => r.ok && r.fresh).length], [true, 1]);
  const standing = ((await certificatesFor(course.id))?.list ?? []).filter((c) => !c.withdrawnAt);
  is("and one standing per student in the creator's list", standing.map((c) => c.email).sort(), ["ana@example.com", "cy@example.com"]);

  part("Withdrawn");
  const id = first.ok ? first.certificate.id : "";
  is("not through another course", await withdrawCertificate("d".repeat(32), id), false);
  is("withdrawn", await withdrawCertificate(course.id, id), true);
  is("its page says so: the record stays, marked withdrawn", ((await readCertificate(id))?.withdrawnAt ?? 0) > 0, true);
  is("it is no longer the student's", await certificateOf(course.id, "ana"), null);
  const renewed = await issueCertificate(input("ana", "Ana M. Lopes"));
  is("the student may be issued a new one, under the name typed now", renewed.ok ? [renewed.fresh, renewed.certificate.id !== id, renewed.certificate.name] : renewed, [true, true, "Ana M. Lopes"]);

  done();
}

void main();
