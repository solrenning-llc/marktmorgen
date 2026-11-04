/**
 * Two subject lines for one email: who gets which, what decides it, and what
 * the studio is told about a decision that was not one.
 *
 * Read before it was built (6 October 2026): Kajabi picks a broadcast test's
 * winner by open or click rate, counted with a tracking pixel. This store
 * promises no pixel and no tracked link in an email (app/privacy), so the
 * winner here is the subject whose links brought more visits or sales, from
 * counts that never knew who anybody was.
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { advanceBroadcast, createBroadcast, linksToStore, readBroadcast } from "@/lib/broadcasts";
import { broadcastCampaign, variantCampaign } from "@/lib/mail-links";
import { broadcastMoney, readMailVisits } from "@/lib/mail-revenue";
import { MIN_TEST_REACH, chooseSubject, newTest, parseTest, partAt, splitFor } from "@/lib/mail-test";
import { campaignViews } from "@/lib/stats";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { type CapturedMail, installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "owner@example.com";
const mail = installSesMailFixture();
const subjectsOf = (messages: CapturedMail[]) => [...new Set(messages.map((message) => message.subject))];
const campaignsOf = (messages: CapturedMail[]) => [...new Set(messages.flatMap((message) =>
  [...message.html.matchAll(/utm_campaign=([a-z0-9-]+)/g)].map((found) => found[1])
))];
const today = () => new Date().toISOString().slice(0, 10);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.RESEND_API_KEY = "re_test_subject_test_only_a_stand_in";

  part("What a test may be");
  is("nothing asked for is no test", newTest(undefined, "Bread", 150), "none");
  is("the same line twice is refused, whatever its capitals", newTest({ subjectB: "  BREAD " }, "Bread", 150), "subject");
  is("so is an empty second line", newTest({ subjectB: "   " }, "Bread", 150), "subject");
  const asked = newTest({ subjectB: "Forty dinners", share: 33, hours: 7, by: "opens" }, "Bread", 150);
  is("a choice not on offer falls back to the usual one", asked === "none" || asked === "subject" ? null : [asked.share, asked.hours, asked.by], [20, 4, "visits"]);
  is("what was saved before tests existed reads as no test", parseTest(undefined), null);

  part("Who gets which");
  is("a fifth of a hundred, halved", splitFor(100, 20), { a: 10, b: 10 });
  is("an odd group gives the first subject the odd one", splitFor(105, 50), { a: 27, b: 26 });
  const shape = { a: 10, b: 10 };
  is("the first part", partAt(shape, 0, 100), { part: "a", end: 10 });
  is("the second starts where the first ends", partAt(shape, 10, 100), { part: "b", end: 20 });
  is("then the rest, to the end of the list", partAt(shape, 20, 100), { part: "rest", end: 100 });

  part("What decides it");
  const even = { a: 50, b: 50, by: "visits" as const };
  is("more visits wins", chooseSubject(even, { a: 9, b: 14 }, null).winner, "b");
  is("and the reason gives the counts it was decided on", chooseSubject(even, { a: 9, b: 14 }, null).why, "The second subject brought 14 visits to your store from 50 emails, against 9 from 50, so the rest got it.");
  is("compared for each email sent, not in total", chooseSubject({ a: 60, b: 40, by: "visits" }, { a: 12, b: 10 }, null).winner, "b");
  const level = chooseSubject(even, { a: 7, b: 7 }, null);
  is("level is the first subject", level.winner, "a");
  is("and is said not to be a finding", level.why.includes("not chosen on merit"), true);
  const unread = chooseSubject(even, null, null);
  is("counts that could not be read: the first, and said", [unread.winner, unread.why.includes("could not be read")], ["a", true]);
  const sold = { a: 50, b: 50, by: "sales" as const };
  is("by sales, more sales wins even with fewer visits", chooseSubject(sold, { a: 20, b: 5 }, { a: 1, b: 3 }).winner, "b");
  const tied = chooseSubject(sold, { a: 4, b: 11 }, { a: 0, b: 0 });
  is("by sales with nobody having bought yet, visits decide", tied.winner, "b");
  is("and the reason says that is what happened", tied.why.startsWith("Neither subject had sold more when the time was up, so visits decided"), true);
  is("by sales with nothing separating them anywhere: the first", chooseSubject(sold, { a: 3, b: 3 }, { a: 1, b: 1 }).winner, "a");

  part("A link to the store");
  const shop = { handle: "harbor", domain: null };
  is("a link to the store's own page", linksToStore("Read it at https://marktmorgen.com/@harbor/p/bread.", shop), true);
  is("somebody else's address is not one", linksToStore("See https://example.com/bread and https://marktmorgen.com/@other", shop), false);
  is("no link at all", linksToStore("It is ready.", shop), false);

  part("Asking for one");
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  const join = async (from: number, to: number) => {
    for (let i = from; i < to; i += 1) await upsertContact(listId, `reader${i}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
  };
  const body = "The plan is out.\n\nRead it at https://marktmorgen.com/@harbor today.";
  const test = { subjectB: "Forty dinners, one plan", share: 20, hours: 4, by: "visits" };
  const ask = (over: Record<string, unknown> = {}) =>
    createBroadcast(store, { subject: "The plan is here", body, productId: "", notProductId: "", sendAt: undefined, test, ...over });

  await join(0, MIN_TEST_REACH - 1);
  const small = await ask();
  is("one short of a hundred people is refused, with the reason", small.ok ? "made" : small.reason, "test_small");
  await join(MIN_TEST_REACH - 1, 120);
  const same = await ask({ test: { ...test, subjectB: "the plan is here" } });
  is("the same subject twice is refused", same.ok ? "made" : same.reason, "test_subject");
  const linkless = await ask({ body: "The plan is out. Reply and I will send it." });
  is("an email with no link to the store is refused: there would be nothing to count", linkless.ok ? "made" : linkless.reason, "test_links");
  const plain = await ask({ test: undefined, body: "The plan is out. Reply and I will send it." });
  is("the same email without a test is taken as it always was", plain.ok && plain.broadcast.test === null, true);

  part("The test goes out, and the rest wait");
  const created = await ask();
  if (!created.ok) throw new Error(`no broadcast: ${created.reason}`);
  const id = created.broadcast.id;
  mail.clearCaptured();
  let b = (await advanceBroadcast(id, storeForHandle, Date.now() + 60_000))!;
  const testedMail = mail.ses.slice();
  is("it is waiting, and no subject is chosen yet", [b.status, b.test?.winner], ["waiting", ""]);
  is("a fifth of 120 went: twelve of each", [b.sent, b.test?.a, b.test?.b], [24, 12, 12]);
  is("the two subject groups keep their order and never mix", testedMail.map((message) => message.subject), [
    ...Array(12).fill("The plan is here"),
    ...Array(12).fill("Forty dinners, one plan"),
  ]);
  is("each subject's links carry its own tag",
    [campaignsOf(testedMail.slice(0, 12)), campaignsOf(testedMail.slice(12))],
    [[variantCampaign(id, "a")], [variantCampaign(id, "b")]]);
  is("the tag is one for everybody who got that subject, never one each",
    new Set(testedMail.slice(0, 12).map((message) => message.html.match(/href="([^"]*utm_campaign[^"]*)"/)?.[1])).size, 1);
  is("list variants never fall through to Resend", mail.resend.length, 0);
  const tested = testedMail.flatMap((message) => message.to);
  is("nobody got both", new Set(tested).size, 24);
  const endsAt = b.test?.endsAt ?? 0;
  is("the rest are due four hours on", Math.abs(endsAt - (Math.floor(Date.now() / 1000) + 4 * 3_600)) <= 5, true);

  mail.clearCaptured();
  b = (await advanceBroadcast(id, storeForHandle, Date.now() + 60_000))!;
  is("asked again before the time is up, nothing more goes", [mail.attempts.length, b.sent, b.status, b.test?.endsAt === endsAt], [0, 24, "waiting", true]);

  part("The better one goes to the rest");
  const statsId = store.statsId as string;
  redis.run(["HINCRBY", `nl:stats:${statsId}:${today()}`, `g:${variantCampaign(id, "a")}`, 2]);
  redis.run(["HINCRBY", `nl:stats:${statsId}:${today()}`, `g:${variantCampaign(id, "b")}`, 5]);
  is("the visits are read for each subject", await campaignViews(statsId, [variantCampaign(id, "a"), variantCampaign(id, "b")], 2), { [variantCampaign(id, "a")]: 2, [variantCampaign(id, "b")]: 5 });
  // The four hours, passed: the time the rest are due is moved into the past.
  const key = `nl:mail:bc:${id}`;
  const held = JSON.parse(String(redis.run(["GET", key]))) as { test: { endsAt: number } };
  held.test.endsAt = Math.floor(Date.now() / 1000) - 1;
  redis.run(["SET", key, JSON.stringify(held)]);
  mail.clearCaptured();
  b = (await advanceBroadcast(id, storeForHandle, Date.now() + 60_000))!;
  const restMail = mail.ses.slice();
  is("it is sent, to all 120", [b.status, b.sent, b.total], ["sent", 120, 120]);
  is("the second subject won, on the counts", [b.test?.winner, b.test?.visits], ["b", { a: 2, b: 5 }]);
  is("and the reason is kept for the studio", b.test?.why, "The second subject brought 5 visits to your store from 12 emails, against 2 from 12, so the rest got it.");
  is("the other 96 got the second subject through SES", [restMail.length, subjectsOf(restMail)], [96, ["Forty dinners, one plan"]]);
  is("under the email's own tag", campaignsOf(restMail), [broadcastCampaign(id)]);
  is("the remaining list never falls through to Resend", mail.resend.length, 0);
  const everyone = [...tested, ...restMail.flatMap((message) => message.to)];
  is("everybody on the list got exactly one email", [everyone.length, new Set(everyone).size], [120, 120]);

  part("What the studio adds up");
  redis.run(["HINCRBY", `nl:stats:${statsId}:${today()}`, `g:${broadcastCampaign(id)}`, 30]);
  is("an email's visits are every subject's and the rest's together", await readMailVisits(store, [id]), { [id]: 37 });
  const revenue = { partial: false, by: { [variantCampaign(id, "a")]: { sales: 1, cents: 2700 }, [broadcastCampaign(id)]: { sales: 2, cents: 5400 }, "b-somebodyelse": { sales: 9, cents: 9 } } };
  is("and so are its sales", broadcastMoney(revenue, id), { sales: 3, cents: 8100 });
  is("an email that sold nothing is not said to have sold $0", broadcastMoney(revenue, "f".repeat(24)), null);

  part("A list that shrank before a scheduled test started");
  store = (await storeForEmail(OWNER))!;
  const later = await ask({ subject: "One more thing" });
  if (!later.ok) throw new Error(`no second broadcast: ${later.reason}`);
  const gone: string[] = [];
  for (let i = 0; i < 40; i += 1) gone.push(`reader${i}@example.com`);
  redis.run(["HDEL", leadsKey(listId), ...gone]);
  mail.clearCaptured();
  const shrunk = (await advanceBroadcast(later.broadcast.id, storeForHandle, Date.now() + 60_000))!;
  is("everyone left gets the first subject through SES", [shrunk.status, shrunk.sent, mail.ses.length, subjectsOf(mail.ses), mail.resend.length], ["sent", 80, 80, ["One more thing"], 0]);
  is("and it is recorded that no test was run", [shrunk.test?.skipped, shrunk.test?.winner], [true, ""]);
  is("what was read back is what was saved", (await readBroadcast(later.broadcast.id))?.test?.skipped, true);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
