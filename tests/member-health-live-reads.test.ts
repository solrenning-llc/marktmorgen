/**
 * Audit A4 (Stripe lists with a page cap): the running members of a store are
 * read one live status at a time (active, trialing, past_due), never as
 * status=all filtered in the code, so ended memberships never fill the pages
 * and an older running member is still read; and the daily come-back run
 * reports a store whose running members did not fit one reading, never takes
 * the members it read for all of them.
 *
 * The Stripe double honors status, limit and starting_after as Stripe does:
 * no status lists every membership not canceled, status=all lists all.
 */
import { memberHealth, runningMembers } from "@/lib/member-health";
import { nudgeStore, sendMemberNudges } from "@/lib/member-nudge";
import { upsertContact } from "@/lib/contacts";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setNudge, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const LIVE = ["active", "trialing", "past_due"];

type Sub = Record<string, unknown> & { id: string; status: string };
type Mail = { to: string[] | string; subject: string; text: string };
const mails: Mail[] = [];
/** Newest first, as Stripe lists them. */
let subs: Sub[] = [];
/** Rows a status's reading returns besides those in that status: a membership that moved between two readings. */
let movedInto: Record<string, Sub[]> = {};
const statusesAsked: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)) as Mail);
    return answer({ id: `email_${mails.length}` });
  }
  if (url.pathname === "/v1/subscriptions") {
    const status = url.searchParams.get("status");
    statusesAsked.push(status ?? "(none)");
    const pool = status === "all" ? subs
      : status ? [...subs.filter((s) => s.status === status), ...(movedInto[status] ?? [])]
      : subs.filter((s) => s.status !== "canceled");
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const start = after ? pool.findIndex((s) => s.id === after) + 1 : 0;
    return answer({ object: "list", data: pool.slice(start, start + limit), has_more: start + limit < pool.length });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_health_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_health_only_a_stand_in";
  redis.clear();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  const OWNER = "reads-owner@example.com";
  const made = await claimHandle(OWNER, "longclub", "Long Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLongClub01", true);
  const club = await addProduct(OWNER, "Long Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "One" });
  if (!added.ok) throw new Error("no lesson");
  course = added.course;
  await saveCourse(course, ROOM);
  await setProductCourse(OWNER, club.product.id, { id: course.id, lessons: 1 });
  await setNudge(OWNER, { on: true, address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  await upsertContact(store.listId as string, "ana@example.com", { agreed: true, explicit: true, source: "buyer", productId: club.product.id, title: "Long Club" }, ROOM);

  const member = (id: string, email: string, over: Record<string, unknown> = {}): Sub => ({
    id,
    status: "active",
    currency: "usd",
    start_date: NOW - 400 * DAY,
    customer: { id: `cus_${id.slice(4)}`, email },
    metadata: { store: "longclub", product: club.product.id },
    items: { data: [{ quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
    ...over,
  });
  const ended = (i: number) => member(`sub_Gone${String(i).padStart(6, "0")}`, `gone${i}@example.com`, { status: "canceled" });

  part("Ended memberships never fill the pages (A4)");
  // A thousand memberships ended since Ana joined, newest first: as many as status=all reads in ten pages.
  subs = [...Array.from({ length: 1000 }, (_, i) => ended(i)), member("sub_Ana0000000001", "ana@example.com")];
  statusesAsked.length = 0;
  const health = (await memberHealth(store, true))!;
  is("the older running member is read, and the reading is complete", [health.members.map((m) => m.email), health.complete], [["ana@example.com"], true]);
  is("only the live statuses are asked, each on its own", [...new Set(statusesAsked)].sort(), [...LIVE].sort());
  mails.length = 0;
  await nudgeStore(store, Date.now() + 20_000);
  is("the older member away from the course gets the come-back email", mails.map((m) => [m.to].flat()[0]), ["ana@example.com"]);

  part("Each live status, one membership once");
  subs = [
    member("sub_Trial000000001", "trial@example.com", { status: "trialing" }),
    member("sub_Late0000000001", "late@example.com", { status: "past_due" }),
    member("sub_Other00000001", "other@example.com", { metadata: { store: "someoneelse", product: club.product.id } }),
    member("sub_Plan000000001", "plan@example.com", { metadata: { store: "longclub", product: club.product.id, kind: "plan" } }),
    member("sub_Unpaid0000001", "unpaid@example.com", { status: "unpaid" }),
    member("sub_Ana0000000001", "ana@example.com"),
  ];
  // Moved from active to past_due between the two readings: listed by both, counted once.
  movedInto = { past_due: [member("sub_Ana0000000001", "ana@example.com", { status: "past_due" })] };
  const read = await runningMembers(store);
  is("trialing, past due and active members of this store, each once; never another store's, a plan or an unpaid one",
    [read.rows.map((r) => r.id).sort(), read.complete], [["sub_Ana0000000001", "sub_Late0000000001", "sub_Trial000000001"], true]);
  movedInto = {};
  // A reading that returns a row in another status than asked does not count it there.
  const asAll = subs;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/subscriptions") return new Response(JSON.stringify({ object: "list", data: asAll, has_more: false }));
    return original(input, init);
  }) as typeof fetch;
  const loose = await runningMembers(store);
  globalThis.fetch = original;
  is("a row in another status than the one asked is counted only in its own reading", loose.rows.map((r) => r.id).sort(), ["sub_Ana0000000001", "sub_Late0000000001", "sub_Trial000000001"]);

  part("More running members than one reading holds: said, never taken as all (A4)");
  // 1,001 active memberships of another store on the same account: this store's reading cannot finish.
  subs = Array.from({ length: 1001 }, (_, i) => member(`sub_Busy${String(i).padStart(6, "0")}`, `busy${i}@example.com`, { metadata: { store: "busyneighbor", product: club.product.id } }));
  is("the reading says it is not complete", (await runningMembers(store)).complete, false);
  store = (await storeForEmail(OWNER))!;
  errors.length = 0;
  const run = await sendMemberNudges(Date.now() + 60_000);
  is("the daily run counts the store whose members did not fit", [run.stores, (run as { incomplete?: unknown }).incomplete], [1, 1]);
  is("and says which store, in the log", errors.some((line) => line.includes("longclub") && /not read/.test(line)), true);
  subs = [member("sub_Ana0000000001", "ana@example.com")];
  await redis.pipeline([["DEL", "nl:nudge:cursor"]]);
  const whole = await sendMemberNudges(Date.now() + 60_000);
  is("a complete reading counts none", (whole as { incomplete?: unknown }).incomplete, 0);

  console.error = originalError;
  done();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
