/**
 * A score for each member, and one email back in for those who stopped coming
 * (lib/member-health-rules.ts, lib/member-health.ts, lib/member-nudge.ts;
 * added 12 October 2026). Checked:
 *
 *   - the rules as the studio states them: paying, a pause, and being away
 *     from the course or community, shared between the two, after a first week;
 *   - members read from Stripe, scored with when they last opened the course,
 *     the lowest first, with the revenue of those at risk;
 *   - the come-back email goes only where it is on with an address, to a
 *     member at risk only for being away who agreed to hear from the creator,
 *     once per period, with the way back in and the list's own footer.
 */
import { NO_NUDGE, bandOf, nudgeFits, parseNudge, scoreOf } from "@/lib/member-health-rules";
import { memberHealth } from "@/lib/member-health";
import { nudgeEmail, nudgeStore, nudgesThisMonth } from "@/lib/member-nudge";
import { freshConfig, lastSeenIn, memberKey, saveConfig, touchMember } from "@/lib/community";
import { touchStudent } from "@/lib/learn";
import { upsertContact } from "@/lib/contacts";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setCommunity, setNudge, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

type Mail = { to: string[] | string; subject: string; text: string };
const mails: Mail[] = [];
let subs: Record<string, unknown>[] = [];
const originalRun = redis.run.bind(redis);
let syntheticCommands = 0;
redis.run = (command) => {
  if (syntheticCommands >= 100_000) throw new Error("synthetic command budget exceeded");
  syntheticCommands += 1;
  return originalRun(command);
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)) as Mail);
    return answer({ id: `email_${mails.length}` });
  }
  if (url.pathname === "/v1/subscriptions") return answer({ object: "list", data: subs, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_health_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_health_only_a_stand_in";
  redis.clear();

  part("The rules");
  const base = { status: "active", setToEnd: false, paused: false, courseSeen: null, communitySeen: null, since: NOW - 60 * DAY };
  is("nothing to measure and paying: 100", scoreOf(base, NOW).score, 100);
  is("a failed payment, or already canceled: 60", [scoreOf({ ...base, status: "past_due" }, NOW).score, scoreOf({ ...base, setToEnd: true }, NOW).score], [60, 60]);
  is("never opened the one course they pay for: at risk", [scoreOf({ ...base, courseSeen: 0 }, NOW).score, bandOf(scoreOf({ ...base, courseSeen: 0 }, NOW).score)], [30, "risk"]);
  is("in their first week, not yet", scoreOf({ ...base, courseSeen: 0, since: NOW - 3 * DAY }, NOW).score, 100);
  is("away 30 days, 20 days, or this week", [
    scoreOf({ ...base, courseSeen: NOW - 31 * DAY }, NOW).score,
    scoreOf({ ...base, courseSeen: NOW - 20 * DAY }, NOW).score,
    scoreOf({ ...base, courseSeen: NOW - 2 * DAY }, NOW).score,
  ], [37, 72, 100]);
  is("shared when there is a course and a community", scoreOf({ ...base, courseSeen: NOW - 31 * DAY, communitySeen: NOW - DAY }, NOW), { score: 68, factors: [{ reason: "course-30", points: 32 }] });
  is("while paused, being away is not held against them", scoreOf({ ...base, paused: true, courseSeen: 0 }, NOW).score, 85);
  is("the email answers only being away", [
    nudgeFits(30, [{ reason: "course-never", points: 70 }]),
    nudgeFits(0, [{ reason: "payment", points: 40 }, { reason: "course-never", points: 70 }]),
    nudgeFits(72, [{ reason: "course-14", points: 28 }]),
  ], [true, false, false]);
  is("on only with a postal address", [parseNudge({ on: true, address: " " }), parseNudge({ on: true, address: "1 Main St" }).on], [NO_NUDGE, true]);

  part("The community, read for many at once");
  await redis.pipeline([["HSET", "nl:cm:" + "c".repeat(32) + ":m", "x", "y"]]);
  is("nobody who never came in has a visit", [...(await lastSeenIn("c".repeat(32), ["ana@example.com"])).values()], [0]);

  part("A store's members");
  const OWNER = "owner@example.com";
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  const club = await addProduct(OWNER, "Weeknight Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "One" });
  if (!added.ok) throw new Error("no lesson");
  course = added.course;
  await saveCourse(course, ROOM);
  await setProductCourse(OWNER, club.product.id, { id: course.id, lessons: 1 });
  let store = (await storeForEmail(OWNER))!;

  const member = (id: string, email: string, over: Record<string, unknown> = {}) => ({
    id,
    status: "active",
    currency: "usd",
    start_date: NOW - 90 * DAY,
    customer: { id: `cus_${id.slice(4)}`, email },
    metadata: { store: "harbor", product: club.product.id },
    items: { data: [{ quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
    ...over,
  });
  subs = [
    member("sub_Ana000000001", "ana@example.com"),
    member("sub_Ben000000001", "ben@example.com"),
    member("sub_Cy0000000001", "cy@example.com", { status: "past_due" }),
    member("sub_Dee000000001", "dee@example.com", { metadata: { store: "harbor", product: club.product.id, kind: "plan" } }),
    member("sub_Eve000000001", "eve@example.com", { status: "canceled" }),
  ];
  await touchStudent(course.id, "ben@example.com", NOW - 80 * DAY, ROOM);
  const health = (await memberHealth(store, true))!;
  is("running members only, the lowest first, each with why", health.members.map((m) => [m.email, m.score, m.factors.map((f) => f.reason)]), [
    ["cy@example.com", 0, ["payment", "course-never"]],
    ["ana@example.com", 30, ["course-never"]],
    ["ben@example.com", 100, []],
  ]);
  is("counted by band, with the revenue at risk", [health.counts, health.atRisk], [{ well: 1, slipping: 0, risk: 2 }, 4000]);
  // A membership sold before the store changed its currency, paying in euros and at risk (22 [E5], unit 2e).
  const kept = subs;
  subs = [...subs, member("sub_Fay000000001", "fay@example.com", { currency: "eur", status: "past_due" })];
  const mixed = (await memberHealth(store, true))!;
  const fay = mixed.members.find((m) => m.email === "fay@example.com");
  is("a member paying in another currency: shown in it, counted at risk apart, never added", [fay?.own, fay?.monthly, mixed.atRisk, mixed.atRiskElsewhere], [{ cents: 2000, currency: "eur" }, 0, 4000, 1]);
  subs = kept;
  await memberHealth(store, true);

  part("Unknown activity evidence never becomes 'never opened'");
  const originalPipeline: typeof redis.pipeline = redis.pipeline.bind(redis);
  let activityReads = 0;
  redis.pipeline = async (commands) => {
    if (commands.some((command) => command[0] === "HMGET" && String(command[1]).includes(":students"))) {
      activityReads += 1;
      return [[]];
    }
    return originalPipeline(commands);
  };
  let reportRefused = false;
  try { await memberHealth(store, true); } catch { reportRefused = true; }
  is("an incomplete course activity reply refuses the report", [reportRefused, activityReads], [true, 1]);
  redis.pipeline = async (commands) => {
    if (commands.some((command) => command[0] === "HMGET" && String(command[1]).includes(":students"))) throw new Error("synthetic activity read unavailable");
    return originalPipeline(commands);
  };

  part("The email back in");
  is("on only with an address", (await setNudge(OWNER, { on: true, address: "" })).ok, false);
  is("saved with one", (await setNudge(OWNER, { on: true, address: "1 Main St, Portland, OR 97201" })).ok, true);
  store = (await storeForEmail(OWNER))!;
  for (const email of ["ana@example.com", "cy@example.com"]) {
    await upsertContact(store.listId as string, email, { agreed: true, explicit: true, source: "buyer", productId: club.product.id, title: "Weeknight Club" }, ROOM);
  }
  let nudgeRefused = false;
  try { await nudgeStore(store, Date.now() + 20_000); } catch { nudgeRefused = true; }
  is("an unavailable activity read sends no come-back email", [nudgeRefused, mails.length], [true, 0]);
  redis.pipeline = originalPipeline;
  await nudgeStore(store, Date.now() + 20_000);
  is("only the member away, who agreed; not the one whose payment failed", mails.map((m) => [m.to].flat()[0]), ["ana@example.com"]);
  const mail = mails[0];
  is("says what is waiting, with the way back in and the list's footer", [
    mail.subject,
    mail.text.includes(`/course/${club.product.id}`),
    mail.text.includes("1 Main St, Portland, OR 97201"),
    /unsubscribe/i.test(mail.text),
  ], ["Weeknight Club is still here for you", true, true, true]);
  await nudgeStore(store, Date.now() + 20_000);
  is("once per period they pay for", [mails.length, await nudgesThisMonth(store)], [1, 1]);
  is("the words in the store's language", nudgeEmail({ storeName: "Harbor", title: "Club", courseUrl: "u", communityUrl: "", language: "de" }).subject, "Club ist weiter für Sie da");

  part("Unknown community activity cannot certify a report or send a comeback email");
  const communityOwner = "community-owner@example.com";
  const communityStore = await claimHandle(communityOwner, "health-community", "Community Club", "");
  if (!communityStore.ok) throw new Error("no community store");
  await ensureStatsId(communityOwner);
  await ensureListId(communityOwner);
  await setStripeAccount(communityOwner, "acct_TestCm00001", true);
  await setCommunity(communityOwner, true);
  await setNudge(communityOwner, { on: true, address: "1 Main St, Portland, OR 97201" });
  const communityProduct = await addProduct(communityOwner, "Community Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!communityProduct.ok) throw new Error("no community product");
  const communityStoreNow = (await storeForEmail(communityOwner))!;
  const communityId = communityStoreNow.community!.id;
  const communityConfig = { ...freshConfig("Club"), access: [communityProduct.product.id] };
  await saveConfig(communityId, communityConfig);
  const visitor = await touchMember(communityId, "visitor@example.com", null, ROOM);
  if (!visitor) throw new Error("no community visitor");
  await upsertContact(communityStoreNow.listId as string, "visitor@example.com", { agreed: true, explicit: true, source: "buyer", productId: communityProduct.product.id, title: "Community Club" }, ROOM);
  subs = [member("sub_Community0001", "visitor@example.com", { metadata: { store: communityStoreNow.handle, product: communityProduct.product.id } })];
  mails.length = 0;
  const communityControl = (await memberHealth(communityStoreNow, true))!;
  is("a confirmed visit today stays healthy and sends no email", [communityControl.members[0]?.score, communityControl.atRisk, communityControl.complete, await nudgeStore(communityStoreNow, Date.now() + 20_000), mails.length], [100, 0, true, 0, 0]);

  const memberRecord = JSON.stringify(visitor);
  const malformedActivity: [string, unknown[]][] = [
    ["missing pipeline reply", []],
    ["extra pipeline reply", [[memberRecord], null]],
    ["empty HMGET", [[]]],
    ["non-array HMGET", [{}]],
    ["null HMGET", [null]],
    ["overfull HMGET", [[memberRecord, null]]],
    ["unparseable member", [["{cut"]]],
    ["missing member identity", [["{}"]]],
    ["unknown visit time", [[JSON.stringify({ ...visitor, seen: null, at: null })]]],
    ["negative visit time", [[JSON.stringify({ ...visitor, seen: -1 })]]],
  ];
  for (const [index, [name, reply]] of malformedActivity.entries()) {
    subs[0].id = `sub_Community${index + 2}`;
    await originalPipeline([
      ["DEL", `nl:health:${communityStoreNow.statsId}`],
    ]);
    mails.length = 0;
    let targeted = 0;
    redis.pipeline = async (commands) => {
      if (commands.some((command) => command[0] === "HMGET" && command[1] === `nl:cm:${communityId}:m`)) {
        targeted += 1;
        return reply;
      }
      return originalPipeline(commands);
    };
    let refused = false;
    try { await memberHealth(communityStoreNow, true); } catch { refused = true; }
    const cache = await originalPipeline([["GET", `nl:health:${communityStoreNow.statsId}`]]);
    let emailRefused = false;
    try { await nudgeStore(communityStoreNow, Date.now() + 20_000); } catch { emailRefused = true; }
    redis.pipeline = originalPipeline;
    is(`${name}: report and successful cache are refused`, [refused, cache[0] === null], [true, true]);
    is(`${name}: no false comeback email`, [emailRefused, mails.length], [true, 0]);
    is(`${name}: both real consumers reached the activity boundary`, targeted, 2);
  }
  const directEmails = ["absent@example.com", "removed@example.com", "visitor@example.com"];
  const removed = { ...visitor, k: memberKey(directEmails[1]), e: directEmails[1], removed: true };
  await originalPipeline([["HSET", `nl:cm:${communityId}:m`, removed.k, JSON.stringify(removed)]]);
  is("confirmed absent, removed and recently seen members remain distinct", [...(await lastSeenIn(communityId, directEmails)).values()], [0, 0, visitor.seen]);
  let shortRefused = false;
  redis.pipeline = async (commands) => commands.some((command) => command[0] === "HMGET" && command[1] === `nl:cm:${communityId}:m`) ? [[null]] : originalPipeline(commands);
  try { await lastSeenIn(communityId, directEmails); } catch { shortRefused = true; }
  redis.pipeline = originalPipeline;
  is("a short multi-member answer is unknown, not absent", shortRefused, true);

  part("Unknown scoring prerequisites cannot make a report complete");
  for (const boundary of ["listing", "community configuration"] as const) {
    await originalPipeline([["DEL", `nl:health:${communityStoreNow.statsId}`]]);
    let targeted = false;
    redis.pipeline = async (commands) => {
      const isTarget = commands.some((command) => boundary === "community configuration"
        ? command[0] === "GET" && command[1] === `nl:cm:${communityId}:cfg`
        : command[0] === "GET" && String(command[1]).startsWith("nl:catalog:"));
      if (isTarget) { targeted = true; throw new Error("synthetic scoring prerequisite unavailable"); }
      return originalPipeline(commands);
    };
    let refused = false;
    const readStore = boundary === "listing" ? { ...communityStoreNow, catalog: { ...communityStoreNow.catalog, head: [], inline: null } } : communityStoreNow;
    try { await memberHealth(readStore, true); } catch { refused = true; }
    redis.pipeline = originalPipeline;
    is(`${boundary}: the fixture reached the requested read`, targeted, true);
    is(`${boundary}: unknown cannot certify or cache a complete score`, [refused, (await originalPipeline([["GET", `nl:health:${communityStoreNow.statsId}`]]))[0] === null], [true, true]);
  }
  console.log(`Synthetic Redis commands: ${syntheticCommands}/100000.`);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
