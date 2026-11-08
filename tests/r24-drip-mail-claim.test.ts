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
import { emailKey, sendDripEmails } from "@/lib/learn";
import type { Course } from "@/lib/course";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

const mail = installSesMailFixture();

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
const isMark = (cmd: Cmd) => cmd[0] === "SET" && String(cmd[1]).includes(":dripmail:") && cmd.includes("NX");
const isUndo = (cmd: Cmd) => cmd[0] === "DEL" && String(cmd[1]).includes(":dripmail:");
/**
 * How the drip mark's SET NX (or its undoing DEL) answers: "landed" runs it and answers `reply`; "lost" runs
 * nothing and answers `reply`; "short" runs nothing and the pipeline answers no replies at all.
 */
let mode: { pick: (cmd: Cmd) => boolean; how: "landed" | "lost" | "short"; reply?: unknown } | null = null;
redis.pipeline = (async (commands: Cmd[]) => {
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
  const store = { ...real, catalog: { ...real.catalog, items: [{ id: product.id }], inline: [product] } } as unknown as Store;
  await original([["SADD", "nl:courses:drip", `${course.id}|${store.handle}|${product.id}`]]);
  let n = 0;
  /** A new student, a day and a half in, whose second week opened half a day ago. */
  const student = async (): Promise<string> => {
    n += 1;
    const email = `drip-student-${n}@example.com`;
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

  part("A failed send whose undoing DEL answers in another shape: the pass ends, and nothing is sent twice");
  const undone = await student();
  mail.setSesOutcome(["refused"]);
  mode = { pick: isUndo, how: "lost", reply: "QUEUED" };
  is("the pass ends without counting it sent", (await run()).sent, 0);
  mode = null;
  await run();
  is("its mark stays, so it is never sent twice (at worst not at all)", [to(undone), typeof (await original([["GET", markOf(undone)]]))[0]], [0, "string"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
