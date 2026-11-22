/**
 * A second full refund of the same student and course, within the walk's mark (REFUND_WALK_SECONDS), walks the
 * student's list again (Claude 4 AA's LEVE on #3409 @169873bf5a, relayed by Claude 2 on 21/11/2026): the walk's "done"
 * mark names the payment it was walked for, so a later refund of another payment is never stopped by it. Before this,
 * the mark said only "done" for 60 days a student and course, and a certificate issued after a re-purchase and then
 * replaced by the creator (withdrawn, not for a refund) kept showing the name after the second refund.
 * Synthetic: the Redis stand-in only.
 */
import { forgetCertificatesPerson, issueCertificate, readCertificate, withdrawCertificate, withdrawForRefund } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const lesson = (id: string) => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: false, quiz: null }) as unknown as Course["modules"][number]["lessons"][number];
const course: Course = { id: "f".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [lesson("lesson000001")] }] } as Course;

async function walk(email: string, refund: string): Promise<number> {
  let calls = 0;
  for (let more = true; more && calls < 50; calls += 1) more = (await withdrawForRefund(course.id, email, refund)).more;
  return calls;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const email = "twice@example.com";
  const who = emailKey(email);
  const issue = async () => {
    const made = await issueCertificate({ store: "storekey01", productId: "prod01", course, title: "Bookkeeping Basics", creator: "Night School", email, who, name: "Ty Twice", room: ROOM });
    if (!made.ok) throw new Error("not issued");
    return made.certificate.id;
  };

  part("The first refund");
  const first = await issue();
  await walk(email, "pi_test_first0001");
  is("its certificate is withdrawn for the refund", (await readCertificate(first))?.withdrawnFor, "refund");
  is("and the walk's place names that payment", (await redis.pipeline([["GET", `nl:course:${course.id}:certs:rwc:${who}`]]))[0], "done:pi_test_first0001");

  part("Bought again: a certificate issued, then replaced by the creator, then the second payment refunded");
  const replaced = await issue();
  is("the creator withdraws it (not for a refund)", await withdrawCertificate(course.id, replaced), true);
  const standing = await issue();
  await walk(email, "pi_test_second0001");
  is("the standing one is withdrawn for the refund", (await readCertificate(standing))?.withdrawnFor, "refund");
  is("and so is the replaced one, which the first refund's mark no longer hides", (await readCertificate(replaced))?.withdrawnFor, "refund");
  is("the walk's place now names the second payment", (await redis.pipeline([["GET", `nl:course:${course.id}:certs:rwc:${who}`]]))[0], "done:pi_test_second0001");

  part("The same refund again: nothing is walked or changed");
  is("a call for the second payment again changes nothing and says no more", await withdrawForRefund(course.id, email, "pi_test_second0001"), { changed: false, more: false });

  part("A refund that names no payment is refused, never walked as 'done'");
  let refused = false;
  try {
    await withdrawForRefund(course.id, email, "");
  } catch {
    refused = true;
  }
  is("refused", refused, true);

  await forgetCertificatesPerson([course.id], email, ROOM);
  is("the person's deletion takes the walk's place with it", (await redis.pipeline([["EXISTS", `nl:course:${course.id}:certs:rwc:${who}`]]))[0], 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
