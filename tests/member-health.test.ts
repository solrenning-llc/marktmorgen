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
import { lastSeenIn } from "@/lib/community";
import { touchStudent } from "@/lib/learn";
import { upsertContact } from "@/lib/contacts";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setNudge, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

type Mail = { to: string[] | string; subject: string; text: string };
const mails: Mail[] = [];
let subs: Record<string, unknown>[] = [];

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

  part("The email back in");
  is("on only with an address", (await setNudge(OWNER, { on: true, address: "" })).ok, false);
  is("saved with one", (await setNudge(OWNER, { on: true, address: "1 Main St, Portland, OR 97201" })).ok, true);
  store = (await storeForEmail(OWNER))!;
  for (const email of ["ana@example.com", "cy@example.com"]) {
    await upsertContact(store.listId as string, email, { agreed: true, explicit: true, source: "buyer", productId: club.product.id, title: "Weeknight Club" }, ROOM);
  }
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

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
