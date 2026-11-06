/**
 * Proof for review of PR #2717: lastSeenMany now throws UnknownReplyError on an
 * unknown HMGET shape, but its only caller (lib/member-health.ts:133) catches it
 * into an empty Map, so an active student is scored "course-never" and, with the
 * nudge on, receives the come-back email. Expected (rule 24): unknown is never
 * "never opened"; no email. This test asserts the SAFE outcome and so FAILS today.
 */
import { memberHealth } from "@/lib/member-health";
import { nudgeStore } from "@/lib/member-nudge";
import { touchStudent } from "@/lib/learn";
import { upsertContact } from "@/lib/contacts";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setNudge, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const mails: { to: string[] | string; subject: string }[] = [];
let subs: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") { mails.push(JSON.parse(String(init?.body))); return answer({ id: `email_${mails.length}` }); }
  if (url.pathname === "/v1/subscriptions") return answer({ object: "list", data: subs, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

let unknownHmget = false;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (unknownHmget && commands.length === 1 && commands[0]?.[0] === "HMGET" && String(commands[0]?.[1]).includes(":students")) return [7];
  return pipeline(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_health_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_health_only_a_stand_in";
  redis.clear();
  const OWNER = "owner@example.com";
  if (!(await claimHandle(OWNER, "harbor", "Harbor Kitchen", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER); await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  const club = await addProduct(OWNER, "Weeknight Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "One" });
  if (!added.ok) throw new Error("no lesson");
  course = added.course;
  await saveCourse(course, ROOM);
  await setProductCourse(OWNER, club.product.id, { id: course.id, lessons: 1 });
  subs = [{ id: "sub_Ben000000001", status: "active", currency: "usd", start_date: NOW - 90 * DAY, customer: { id: "cus_Ben", email: "ben@example.com" },
    metadata: { store: "harbor", product: club.product.id },
    items: { data: [{ quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] } }];
  await touchStudent(course.id, "ben@example.com", NOW - 80 * DAY, ROOM); // Ben opened the course just now.
  await setNudge(OWNER, { on: true, address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  await upsertContact(store.listId as string, "ben@example.com", { agreed: true, explicit: true, source: "buyer", productId: club.product.id, title: "Weeknight Club" }, ROOM);

  part("Exact reply: Ben is well and gets no email");
  is("exact: score", (await memberHealth(store, true))!.members.map((m) => [m.email, m.score]), [["ben@example.com", 100]]);

  part("Unknown HMGET shape: must not become 'never opened'");
  unknownHmget = true;
  const h = (await memberHealth(store, true))!;
  is("unknown: Ben is not scored course-never", h.members.map((m) => m.factors.map((f) => f.reason)), [[]]);
  await nudgeStore(store, Date.now() + 20_000);
  is("unknown: no come-back email to an active student", mails.map((m) => [m.to].flat()[0]), []);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
