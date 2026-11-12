/**
 * A course's drip email whose send came back unknown is not sent again
 * (lib/learn.ts, sendDripEmails; Claude 2 on #3276, finding 2).
 *
 * Amazon SES answering a 5xx, or its reply lost after the request, may follow
 * acceptance: the email may already be in the student's inbox. sendEmail
 * answers false for it as for a refusal, and the drip job let its once-only
 * mark go on any false, so the next daily pass, while the module is still
 * inside its three-day window, sent the same "a new module opened" email
 * again: up to three copies per student and module, each one taken from the
 * store's email room. A known refusal (nothing taken) still lets the mark go,
 * so the email is tried again rather than never (tests/r24-drip-mail-claim.test.ts).
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

const NOW = Math.floor(Date.now() / 1000);
const lesson = { id: "lesson000001", title: "First", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null };
const course = { id: "d".repeat(32), certificate: false, startsAt: null, modules: [{ id: "module000002", title: "Week two", dripDays: 1, lessons: [lesson] }] } as unknown as Course;

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await claimHandle("drip-unknown@example.com", "drip-unknown-shop", "Drip Unknown Shop", "");
  await setSubscription("drip-unknown@example.com", { customerId: "cus_DripUnknown01", subscriptionId: "sub_DripUnknown01", active: true, tier: "pro", cycle: "month", trialEnds: 0, period: paidPeriod() });
  const real = (await storeForEmail("drip-unknown@example.com"))!;
  const product = { id: "prod00000001", title: "The Course", summary: "", priceCents: 6900, createdAt: 1, course: { id: course.id } };
  const store = { ...real, catalog: { ...real.catalog, items: [{ id: product.id }], inline: [product] } } as unknown as Store;
  await redis.pipeline([["SADD", "nl:courses:drip", `${course.id}|${store.handle}|${product.id}`]]);
  let n = 0;
  /** A new student, a day and a half in, whose second week opened half a day ago. */
  const student = async (): Promise<string> => {
    n += 1;
    const email = `drip-unknown-${n}@example.com`;
    await redis.pipeline([["HSET", `nl:course:${course.id}:students`, emailKey(email), JSON.stringify({ e: email, s: NOW - 36 * 3600, l: NOW })]]);
    return email;
  };
  const run = () => sendDripEmails(async (handle) => (handle === store.handle ? store : null), async (id) => (id === course.id ? course : null), "https://marktmorgen.com", NOW);
  const asked = (email: string) => mail.sesAttempts.filter((m) => m.to.includes(email)).length;

  part("SES's reply lost after the request: the email may have gone, and it is not sent again");
  const lost = await student();
  mail.setSesOutcome(["lost"]);
  await run();
  is("SES was asked once", asked(lost), 1);
  await run();
  await run();
  is("the next passes do not ask again", asked(lost), 1);

  part("SES answered a server error: the email may have gone, and it is not sent again");
  const fivexx = await student();
  mail.setSesOutcome(["server-error"]);
  await run();
  is("SES was asked once", asked(fivexx), 1);
  await run();
  is("the next pass does not ask again", asked(fivexx), 1);

  part("A known refusal is still tried again, once");
  const refused = await student();
  mail.setSesOutcome(["refused"]);
  await run();
  await run();
  await run();
  is("asked twice: the refusal, then the one that went", asked(refused), 2);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
