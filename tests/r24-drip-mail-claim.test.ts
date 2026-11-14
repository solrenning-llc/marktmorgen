/**
 * A course's drip email is claimed exactly before it is sent (lib/learn.ts, sendDripEmails; CX-123 rule 24,
 * lib/claim-mark.ts).
 *
 * Before: the mark's SET NX counted as "this run's to send" on any reply but nil, so a reply in another shape (or a
 * pipeline that answered nothing) sent the email without a mark known to be ours: when the mark had not landed, the
 * next pass of the job sent it again, and when the mark was already somebody else's (an earlier pass's) the student
 * got it twice. Now the mark is ours only on exactly "OK" or on our own value read back; nil, or another value read
 * back, is an email already sent; anything else is unknown: nothing is sent this pass, and a later pass tries again.
 * A failed send takes the mark back, and that DEL's own count says whether it went.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts) and the synthetic SES (tests/ses-mail-fixture.ts); nothing leaves.
 */
import { claimHandle, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { emailKey, recordEnrollment, sendDripEmails } from "@/lib/learn";
import { KIND } from "@/lib/catalog";
import type { Course } from "@/lib/course";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

const mail = installSesMailFixture();

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
const isMark = (cmd: Cmd) => cmd[0] === "SET" && String(cmd[1]).includes(":dripmail:") && cmd.includes("NX");
/** The mark taken back after a send that did not go: the compare-and-delete script (lib/claim-mark.ts, releaseMark). */
const isUndo = (cmd: Cmd) => cmd[0] === "EVAL" && String(cmd[1]).startsWith("-- marktmorgen:release:v1\n") && String(cmd[3]).includes(":dripmail:");
/** The drip mark whose next read-back (a GET of it alone) throws, as a second timeout would. */
let readBackFails: string | null = null;
/** A mark written over by somebody else just before this pass takes its own back (on the DEL or the script). */
let swapBeforeUndo: string | null = null;
/**
 * How the drip mark's SET NX (or its undoing DEL) answers: "landed" runs it and answers `reply`; "lost" runs
 * nothing and answers `reply`; "short" runs nothing and the pipeline answers no replies at all.
 */
let mode: { pick: (cmd: Cmd) => boolean; how: "landed" | "lost" | "short"; reply?: unknown } | null = null;
redis.pipeline = (async (commands: Cmd[]) => {
  if (readBackFails && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === readBackFails) {
    readBackFails = null;
    throw new Error("synthetic: the read-back timed out");
  }
  const swap = swapBeforeUndo;
  if (swap && commands.some((cmd) => cmd.map(String).includes(swap) && (cmd[0] === "DEL" || cmd[0] === "EVAL"))) {
    swapBeforeUndo = null;
    await original([["SET", swap, "somebody-elses-mark", "EX", 400 * 86_400]]);
  }
  const m = mode;
  if (!m || !commands.some(m.pick)) return original(commands);
  if (m.how === "short") return [];
  const kept = commands.filter((cmd) => m.how === "landed" || !m.pick(cmd));
  const out = await original(kept);
  let at = 0;
  return commands.map((cmd) => {
    if (!m.pick(cmd)) return out[at++];
    if (m.how === "landed") at += 1;
    return m.reply;
  });
}) as typeof redis.pipeline;

const NOW = Math.floor(Date.now() / 1000);
const lesson = { id: "lesson000001", title: "First", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null };
const course = { id: "c".repeat(32), certificate: false, startsAt: null, modules: [{ id: "module000002", title: "Week two", dripDays: 1, lessons: [lesson] }] } as unknown as Course;

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await claimHandle("drip-claim@example.com", "drip-claim-shop", "Drip Claim Shop", "");
  await setSubscription("drip-claim@example.com", { customerId: "cus_DripClaim0001", subscriptionId: "sub_DripClaim0001", active: true, tier: "pro", cycle: "month", trialEnds: 0, period: paidPeriod() });
  const real = (await storeForEmail("drip-claim@example.com"))!;
  const product = { id: "prod00000001", title: "The Course", summary: "", priceCents: 6900, createdAt: 1, course: { id: course.id } };
  // A paid course item, as the catalog lists one (KIND.paid | KIND.course): the course page and the job read it by kind.
  const store = { ...real, catalog: { ...real.catalog, items: [{ id: product.id, kind: KIND.paid | KIND.course, options: [] }], inline: [product] } } as unknown as Store;
  await original([["SADD", "nl:courses:drip", `${course.id}|${store.handle}|${product.id}`]]);
  let n = 0;
  /**
   * A new student, a day and a half in, whose second week opened half a day ago. Bought on that day, written down on
   * the thanks page: the job announces only what the course page opens, from the same start (courseLedger, #3369).
   */
  const student = async (): Promise<string> => {
    n += 1;
    const email = `drip-student-${n}@example.com`;
    await recordEnrollment(store, email, product.id, NOW - 36 * 3600);
    await original([["HSET", `nl:course:${course.id}:students`, emailKey(email), JSON.stringify({ e: email, s: NOW - 36 * 3600, l: NOW })]]);
    return email;
  };
  const run = () => sendDripEmails(async (handle) => (handle === store.handle ? store : null), async (id) => (id === course.id ? course : null), "https://marktmorgen.com", NOW);
  const markOf = (email: string) => `nl:course:${course.id}:dripmail:${emailKey(email)}:module000002`;
  const to = (email: string) => mail.sent.filter((m) => m.to.includes(email)).length;

  part("Healthy control: sent once on exactly OK, not again on nil");
  const healthy = await student();
  await run();
  is("sent once", to(healthy), 1);
  await run();
  is("the next pass sends nothing more", to(healthy), 1);

  part("The mark's reply lost after it landed: our own value read back, sent once");
  const landed = await student();
  mode = { pick: isMark, how: "landed", reply: "QUEUED" };
  await run();
  mode = null;
  await run();
  is("sent once, not again", to(landed), 1);

  part("A reply in another shape, the mark not written: nothing sent this pass, sent once by a later one");
  const lost = await student();
  mode = { pick: isMark, how: "lost", reply: "QUEUED" };
  await run();
  is("unknown: not sent", to(lost), 0);
  mode = { pick: isMark, how: "lost", reply: undefined };
  await run();
  is("an undefined reply sends nothing either", to(lost), 0);
  mode = { pick: isMark, how: "short" };
  await run();
  is("nor a pipeline that answered nothing", to(lost), 0);
  is("no mark was left behind", (await original([["GET", markOf(lost)]]))[0], null);
  mode = null;
  await run();
  await run();
  is("a later pass with Redis well sends it once", to(lost), 1);

  part("Somebody else's mark answered in another shape: never sent twice");
  const taken = await student();
  await original([["SET", markOf(taken), "1", "EX", 400 * 86_400]]);
  mode = { pick: isMark, how: "lost", reply: "QUEUED" };
  await run();
  mode = { pick: isMark, how: "lost", reply: 1 };
  await run();
  mode = null;
  is("read back as another's: nothing sent", to(taken), 0);

  part("A failed send takes its mark back, and the next pass sends it once");
  const failed = await student();
  mail.setSesOutcome(["refused"]);
  await run();
  is("not sent, and the mark taken back", [to(failed), (await original([["GET", markOf(failed)]]))[0]], [0, null]);
  await run();
  is("sent once by the next pass", to(failed), 1);

  part("A failed send whose taking back does not run: nothing is sent twice");
  const undone = await student();
  mail.setSesOutcome(["refused"]);
  mode = { pick: isUndo, how: "lost", reply: "QUEUED" };
  is("the pass goes on without counting it sent", (await run()).sent, 0);
  mode = null;
  await run();
  is("its mark stays, so it is never sent twice (at worst not at all)", [to(undone), typeof (await original([["GET", markOf(undone)]]))[0]], [0, "string"]);

  part("Claude 2 on #3276, finding 1: the mark landed, its reply lost and its read-back failed: unknown, then sent once");
  const unread = await student();
  mode = { pick: isMark, how: "landed", reply: undefined };
  readBackFails = markOf(unread);
  await run();
  mode = null;
  is("the read-back did fail", readBackFails, null);
  is("unknown: not sent this pass", to(unread), 0);
  is("and our own mark taken back, so a later pass is not told it went", (await original([["GET", markOf(unread)]]))[0], null);
  for (let pass = 0; pass < 3; pass += 1) await run();
  is("a later pass with Redis well sends it once", to(unread), 1);

  part("Claude 2 on #3276, low finding 3: a refused send takes back only its own mark (compare-and-delete)");
  const other = await student();
  mail.setSesOutcome(["refused"]);
  swapBeforeUndo = markOf(other);
  await run();
  swapBeforeUndo = null;
  is("a mark that is no longer ours is never taken back", (await original([["GET", markOf(other)]]))[0], "somebody-elses-mark");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
