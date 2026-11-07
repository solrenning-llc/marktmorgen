/**
 * The email back in for a member away (lib/member-nudge.ts) under a sender
 * whose answer is not known (rule 30, a sibling of 283 [HG2] unit 1's
 * sendEmailOutcome).
 *
 * A timeout, a server error or a network error after the request may have
 * reached the sender can mean the email went, and so can a send that went
 * through but whose count could not be written. The once-per-period mark is
 * then kept, so the daily job never writes twice; only a certain refusal
 * lets it go. Stripe and the sender are played by a stand-in for `fetch`;
 * no real email is sent. Checked:
 *
 *   - a 500 from the sender: asked once over two runs, its mark kept;
 *   - a thrown request (network error): the same;
 *   - a 422 (a certain refusal): the mark is let go and the next run asks
 *     again (control: unchanged behavior);
 *   - a plain yes: sent once, counted (control);
 *   - sent, then the month's count not written: the mark is kept, so the
 *     email is not sent again;
 *   - the email is taken from the store's figure before each request, the
 *     uncertain ones included.
 */
import { nudgeStore, nudgesThisMonth } from "@/lib/member-nudge";
import { upsertContact } from "@/lib/contacts";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { allowanceUsed } from "@/lib/store-allowance";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setNudge, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

/** Every recipient the sender was asked for, taken or not. */
const asked: string[] = [];
/** How the sender answers one recipient, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();
let subs: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const to = [(JSON.parse(String(init?.body)) as { to: string | string[] }).to].flat()[0] ?? "";
    asked.push(to);
    const special = senderAnswers.get(to);
    if (special) return special();
    return answer({ id: `email_${asked.length}` });
  }
  if (url.pathname === "/v1/subscriptions") return answer({ object: "list", data: subs, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const askedOf = (email: string) => asked.filter((to) => to === email).length;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_outcome_nudge_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();

  const OWNER = "owner@example.com";
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestNudge00001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Weeknight Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "One" });
  if (!added.ok) throw new Error("no lesson");
  course = added.course;
  await saveCourse(course, ROOM);
  await setProductCourse(OWNER, club.product.id, { id: course.id, lessons: 1 });
  if (!(await setNudge(OWNER, { on: true, address: "1 Main St, Portland, OR 97201" })).ok) throw new Error("no nudge");
  const store = (await storeForEmail(OWNER))!;
  if (!store.listId || !store.statsId) throw new Error("no list");

  // Members who never opened the one course they pay for: each is sent the email back in.
  const member = (id: string, email: string) => ({
    id,
    status: "active",
    currency: "usd",
    start_date: NOW - 90 * DAY,
    customer: { id: `cus_${id.slice(4)}`, email },
    metadata: { store: "harbor", product: club.product.id },
    items: { data: [{ quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
  });
  const people: [string, string][] = [
    ["sub_Una000000001", "una@example.com"],
    ["sub_Tom000000001", "tom@example.com"],
    ["sub_Rex000000001", "rex@example.com"],
    ["sub_Ola000000001", "ola@example.com"],
  ];
  subs = people.map(([id, email]) => member(id, email));
  for (const [, email] of [...people, ["", "cy@example.com"]]) {
    await upsertContact(store.listId, email, { agreed: true, explicit: true, source: "buyer", productId: club.product.id, title: "Weeknight Club" }, ROOM);
  }
  senderAnswers.set("una@example.com", () => answerOf(500));
  senderAnswers.set("tom@example.com", () => {
    throw new TypeError("fetch failed: the connection was reset");
  });
  senderAnswers.set("rex@example.com", () => answerOf(422));
  const mark = (sub: string) => redis.keys().some((k) => k.startsWith(`nl:nudge:${store.statsId}:${sub}:`));

  part("The first run");
  const usedBefore = await allowanceUsed(store, "email");
  await nudgeStore(store, Date.now() + 20_000);
  is("each of the four was asked for once", people.map(([, email]) => askedOf(email)), [1, 1, 1, 1]);
  is("each request was taken from the store's figure first, the uncertain ones included", (await allowanceUsed(store, "email")) - usedBefore, 4);
  is("only the plain yes is counted as sent", await nudgesThisMonth(store), 1);

  part("An answer not known keeps the mark: never twice");
  // The mark is what keeps the next run from writing again; the synthetic sender also holds a repeated idempotency
  // key back, which the real providers do only for a while, so the marks are checked first.
  is("a 500: its mark is kept", mark("sub_Una000000001"), true);
  is("a thrown request: its mark is kept", mark("sub_Tom000000001"), true);
  is("a certain refusal (422): its mark is let go", mark("sub_Rex000000001"), false);
  is("the plain yes: its mark is kept", mark("sub_Ola000000001"), true);
  senderAnswers.clear();
  await nudgeStore(store, Date.now() + 20_000);
  is("the next run does not ask again after a 500", askedOf("una@example.com"), 1);
  is("nor after a thrown request", askedOf("tom@example.com"), 1);
  is("a certain refusal is asked again on the next run", askedOf("rex@example.com"), 2);
  is("the plain yes is not asked again", askedOf("ola@example.com"), 1);
  is("now two sent", await nudgesThisMonth(store), 2);

  part("Sent, then the month's count not written: the mark is kept");
  subs = [...subs, member("sub_Cy0000000001", "cy@example.com")];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "INCR") throw new Error("synthetic: the count could not be written");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  await nudgeStore(store, Date.now() + 20_000);
  redis.pipeline = pipeline;
  is("it was sent", askedOf("cy@example.com"), 1);
  is("its mark is kept", mark("sub_Cy0000000001"), true);
  await nudgeStore(store, Date.now() + 20_000);
  is("the next run does not send it again", askedOf("cy@example.com"), 1);
  // The synthetic sender answers a repeated idempotency key from its receipt without a new request, so a second
  // send would show here as a second count, not as a second ask.
  is("nor count it again (the lost count stays lost)", await nudgesThisMonth(store), 2);

  done();
}

function answerOf(status: number): Response {
  return new Response(JSON.stringify({ message: status >= 500 ? "internal" : "invalid recipient" }), { status });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
