/**
 * Issue #4783 (erasure, MEDIUM; Codex, transcribed by Claude 2): a certificate press already past its checks when the
 * student was erased wrote the certificate (their name and address), the student's slot and both list places after
 * the erasure had completed and found nothing. Now a press that wrote a fresh certificate reads the student's deletion
 * print for the store (written by the erasure before anything is deleted) after its writes; found, it takes back what
 * it wrote and issues nothing. An erasure after that read finds the certificate through its lists. Transcribed from
 * the issue, with the erasure written as lib/person-erasure.ts runs it: the print first, then the certificates.
 */
import { emailKey } from "@/lib/learn";
import { certificateOf, certificatesFor, forgetCertificatesPerson, issueCertificate, readCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { suppressCommand } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const original = redis.pipeline.bind(redis);
const lesson = { id: "lesson000001", title: "One", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null } as unknown as Course["modules"][number]["lessons"][number];
const course: Course = { id: "d".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [lesson] }] } as Course;
const LIST = "e".repeat(32);
const press = (email: string) => issueCertificate({ store: "storekey01", productId: "prod01", course, title: "Bookkeeping Basics", creator: "Night School", email, who: emailKey(email), name: "Ana Lopes", room: ROOM, listId: LIST });

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  const email = "student@example.com";
  const who = emailKey(email);
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let paused = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!paused && commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:cert:"))) { paused = true; reached(); await hold; }
    return original(commands);
  }) as typeof redis.pipeline;
  const pending = press(email);
  await reachedP;
  part("A certificate write paused while the student is erased (the issue's reproduction)");
  await original([suppressCommand(LIST, email)]);
  const gone = await forgetCertificatesPerson([course.id], email, ROOM);
  is("the erasure completes while no certificate has been written yet", gone, 0);
  release();
  const issued = await pending.then((r) => r, (e: unknown) => ({ ok: false as const, reason: String(e) }));
  redis.pipeline = original;
  is("nothing is issued to the erased student", issued.ok, false);
  const ids = (redis.keys().filter((k) => /^nl:cert:[^:]+$/.test(k)));
  is("the in-flight issue does not recreate the certificate record", ids, []);
  is("the erased student has no standing certificate", await certificateOf(course.id, who), null);
  is("the creator's certificate list contains none of the erased student's data", (await certificatesFor(course.id))?.list ?? [], []);

  part("Its commands, every script's own counted, inside one buyer action (line buyer-actions, 100 commands)");
  // The route takes one buyer action (app/api/store/course/certificate/route.ts), priced in tests/plan-cost-registry.ts
  // at the heaviest action's 100 commands besides its take. The dearest press: a fresh certificate whose student was
  // erased meanwhile, so it is written whole, the print read, and all of it taken back.
  {
    redis.clear();
    const run = redis.run.bind(redis);
    let commands = 0;
    let erasedOnce = false;
    redis.run = ((c: (string | number)[]) => {
      commands += 1;
      if (!erasedOnce && c[0] === "SADD" && String(c[1]).includes(":certs:by:")) { erasedOnce = true; run(suppressCommand(LIST, "costed@example.com")); }
      return run(c);
    }) as typeof redis.run;
    const costed = await press("costed@example.com").catch(() => null);
    redis.run = run;
    console.log(`  the dearest press: ${commands} commands`);
    is("taken back", costed?.ok, false);
    is("at most 100 commands, inside one buyer action", commands <= 100, true);
  }

  part("Control: a student nobody erased gets their certificate");
  const kept = await press("other@example.com");
  is("issued, fresh", kept.ok && kept.fresh, true);
  is("readable", kept.ok ? (await readCertificate(kept.certificate.id))?.name : null, "Ana Lopes");
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
