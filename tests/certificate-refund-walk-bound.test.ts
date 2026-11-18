/**
 * A refund's walk of a student's earlier certificates is bounded per call (Codex N1, U and X6 on #3409, MEDIUM):
 * withdrawForRefund (lib/certificate.ts) read the student's whole list (byKey) with one SMEMBERS and marked every
 * certificate in it in the same call, while the refund pass prices each of the month's checks at a fixed
 * CERTIFICATE_PASS_CHECK_COMMANDS (tests/plan-cost-registry.ts). The list has no ceiling of its own. What fails here:
 *   - one call sends more commands than a check is priced at, for a student with many earlier certificates;
 *   - a call reads the whole list in one reply;
 *   - the walk never ends, or ends with a certificate of the list not marked for the refund;
 *   - the walk's place is left behind once done, or survives the person's deletion.
 * Synthetic only: the in-memory Redis.
 */
import { certKey, forgetCertificatesPerson, issueCertificate, readCertificate, REFUND_WALK_IDS, withdrawCertificate, withdrawForRefund } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";
import { CERTIFICATE_PASS_CHECK_COMMANDS } from "./plan-cost-registry";

const lesson = (id: string) => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: false, quiz: null }) as unknown as Course["modules"][number]["lessons"][number];
const course: Course = { id: "e".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [lesson("lesson000001")] }] } as Course;

// Every command and every reply's size, per call.
let commands = 0;
let mostRecords = 0;
const healthy = redis.pipeline;
redis.pipeline = async (batch: (string | number)[][]) => {
  commands += batch.length;
  const replies = await healthy(batch);
  for (const command of batch) if (command[0] === "MGET") mostRecords = Math.max(mostRecords, command.length - 1);
  return replies;
};

const EARLIER = 300;
const id = (n: number) => `w${String(n).padStart(15, "0")}`;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const email = "many@example.com";
  const who = emailKey(email);
  const issued = await issueCertificate({ store: "storekey01", productId: "prod01", course, title: "Bookkeeping Basics", creator: "Night School", email, who, name: "Mo Many", room: ROOM });
  if (!issued.ok) throw new Error("not issued");
  // Earlier certificates of the same course, each withdrawn by the creator, all on the student's own list.
  const earlier = Array.from({ length: EARLIER }, (_, n) => id(n));
  const base = { ...issued.certificate, withdrawnAt: Math.floor(Date.now() / 1000) - 86_400 };
  await healthy([
    ...earlier.map((c) => ["SET", certKey(c), JSON.stringify({ ...base, id: c })]),
    ["SADD", `nl:course:${course.id}:certs:by:${who}`, ...earlier],
  ]);

  part("Each call stays within one check's priced commands, whatever the list holds");
  let calls = 0;
  let most = 0;
  let more = true;
  while (more && calls < EARLIER * 3) {
    commands = 0;
    const result = await withdrawForRefund(course.id, email);
    most = Math.max(most, commands);
    more = result.more;
    calls += 1;
  }
  is(`no call sends more than CERTIFICATE_PASS_CHECK_COMMANDS (${CERTIFICATE_PASS_CHECK_COMMANDS}); the most was ${most}`, most <= CERTIFICATE_PASS_CHECK_COMMANDS, true);
  // The records are what weighs: each call reads at most REFUND_WALK_IDS of them. The ids come a SSCAN page at a time
  // (COUNT REFUND_WALK_SCAN; Redis answers a small set whole, at most 128 ids of 16 characters).
  is(`no call reads more than REFUND_WALK_IDS (${REFUND_WALK_IDS}) records; the most was ${mostRecords}`, mostRecords <= REFUND_WALK_IDS, true);
  is("the walk ends", more, false);
  is("it takes one call for each earlier certificate or so, never one call for all", calls >= EARLIER / REFUND_WALK_IDS, true);

  part("Every certificate of the list ends marked for the refund, the standing one withdrawn");
  const records = await Promise.all([issued.certificate.id, ...earlier].map((c) => readCertificate(c)));
  is("all marked withdrawn for the refund", records.filter((r) => r?.withdrawnFor !== "refund").length, 0);
  is("once done, the ids it kept are gone and its place says done", (await healthy([["EXISTS", `nl:course:${course.id}:certs:rw:${who}`], ["GET", `nl:course:${course.id}:certs:rwc:${who}`]])), [0, "done"]);
  is("a call after the walk changes nothing and says no more", await withdrawForRefund(course.id, email), { changed: false, more: false });

  part("A walk stopped part way is gone with the person");
  const other = "half@example.com";
  const otherWho = emailKey(other);
  const second = await issueCertificate({ store: "storekey01", productId: "prod01", course, title: "Bookkeeping Basics", creator: "Night School", email: other, who: otherWho, name: "Hal Half", room: ROOM });
  if (!second.ok) throw new Error("not issued");
  is("withdrawn by the creator", await withdrawCertificate(course.id, second.certificate.id), true);
  const more2 = Array.from({ length: 40 }, (_, n) => `h${String(n).padStart(15, "0")}`);
  await healthy([...more2.map((c) => ["SET", certKey(c), JSON.stringify({ ...base, id: c, email: other })]), ["SADD", `nl:course:${course.id}:certs:by:${otherWho}`, ...more2]]);
  is("one call leaves more", (await withdrawForRefund(course.id, other)).more, true);
  await forgetCertificatesPerson([course.id], other, ROOM);
  is("the person's deletion takes the walk's place with it", (await healthy([["EXISTS", `nl:course:${course.id}:certs:rw:${otherWho}`, `nl:course:${course.id}:certs:rwc:${otherWho}`]]))[0], 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
