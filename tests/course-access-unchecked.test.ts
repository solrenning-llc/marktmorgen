/**
 * A paying student is told their access could not be checked, never offered to buy what they own (CX-123 rule 24;
 * owner's approval of a distinct state, 12 November 2026). lib/learn.ts courseLedger keeps a course shut while Stripe's
 * answer about refunds cannot be had whole (tests/course-ledger-stripe-unknown.test.ts): fail closed. Until now the
 * course's page then showed that student the closed state, with "Buy the course" and the free-preview pitch, as if they
 * had never paid, and its lesson page sent them to "Get the whole course".
 *
 * Now courseAccess says "unknown" for a course whose opening depended on that answer, and the pages draw it as its own
 * state (lib/course-door.ts): a status notice in plain words, in the store's language, with a link that loads the page
 * again; no checkout, no PayPal button, no preview pitch, no "already bought" form, and the device keeps the student's
 * places in the videos (they are forgotten only when access is known to have ended). The course still does not open.
 * A visitor never seen, or a student Stripe answers about in full, sees the page as before.
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { courseAccess, emailKey, mintPass, passCookieName, recordEnrollment } from "@/lib/learn";
import { closedDoor, forgetsOnDevice } from "@/lib/course-door";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import { readListing } from "@/lib/catalog";
import { notesDownloadAfterAccess } from "@/lib/lesson-notes";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_course_access_unchecked";

const OWNER = "painter@example.com";
const ACCOUNT = "acct_1TestUnchecked1";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
const sessions: Record<string, Row[]> = {};
/** Stripe answering the checkout list, or failing. */
let failing = false;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    if (failing) return answer({ error: { type: "api_error", message: "Stripe is having a moment" } }, 500);
    const email = url.searchParams.get("customer_details[email]") ?? "";
    return answer({ object: "list", data: sessions[email] ?? [], has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const paid = (id: string, product: string): Row => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer_details: { email: "x@example.com" },
  metadata: { store: "unchecked", product },
  payment_intent: {
    id: `pi_${id.slice(8)}`,
    object: "payment_intent",
    latest_charge: { id: `ch_${id.slice(8)}`, object: "charge", amount: 4900, amount_refunded: 0, refunded: false, disputed: false },
  },
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "unchecked", "Unchecked Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Unchecked01", subscriptionId: "sub_Unchecked01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Oil Painting", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductCourse(OWNER, made.product.id, { id: "c".repeat(32), lessons: 3 });
  const store = (await storeForEmail(OWNER))!;
  const product = made.product.id;
  const course = (await readListing(store, product))!;
  const signedIn = async (email: string) => {
    const pass = await mintPass(store, email, "all");
    return { get: (name: string) => (name === passCookieName(store) ? { value: pass } : undefined) };
  };

  part("Stripe's answer whole: open to a buyer, the buy button to anyone else, as before");
  sessions["ruth@example.com"] = [paid("cs_test_ruth00paid01", product)];
  await recordEnrollment(store, "ruth@example.com", product, NOW - 86_400);
  const ruth = await signedIn("ruth@example.com");
  is("a buyer: open", (await courseAccess(store, course, ruth)).state, "open");
  const never = await courseAccess(store, course, await signedIn("noel@example.com"));
  is("signed in, never bought: closed", never.state, "closed");
  is("signed in, never bought: the checkout", closedDoor(never, true, true), "checkout");
  is("signed in, never bought: their device places are forgotten", forgetsOnDevice(never), true);
  const learner = { email: "x@example.com", scope: "all" as const, owner: false };
  is(
    "forgotten when ended or shut, never when open, for the creator, or for a visitor",
    [
      forgetsOnDevice({ state: "ended", learner }),
      forgetsOnDevice({ state: "closed", learner }),
      forgetsOnDevice({ state: "open", learner }),
      forgetsOnDevice({ state: "closed", learner: { ...learner, owner: true } }),
      forgetsOnDevice({ state: "closed", learner: null }),
      forgetsOnDevice({ state: "preview", learner: null }),
    ],
    [true, true, false, false, false, false],
  );
  const visitor = await courseAccess(store, course, { get: () => undefined });
  is("a visitor: closed, with the checkout", [visitor.state, closedDoor(visitor, true, true)], ["closed", "checkout"]);
  is("no checkout: PayPal, then nothing", [closedDoor(visitor, false, true), closedDoor(visitor, false, false)], ["paypal", "none"]);

  part("Stripe's answer unknown: the course stays shut, said as not checked, never as not bought");
  failing = true;
  sessions["sara@example.com"] = [paid("cs_test_sara00paid01", product)];
  await recordEnrollment(store, "sara@example.com", product, NOW - 86_400);
  const sara = await courseAccess(store, course, await signedIn("sara@example.com"));
  is("written down on the thanks page: not open, unknown", sara.state, "unknown");
  is("the page says it could not check, with no checkout", closedDoor(sara, true, true), "unchecked");
  is("nor PayPal, nor anything to buy", [closedDoor(sara, false, true), closedDoor(sara, false, false)], ["unchecked", "unchecked"]);
  is("their places in the videos stay on their device", forgetsOnDevice(sara), false);
  let asked = 0;
  const admit = async () => ((asked += 1), true);
  is(
    "no \"after your access ends\" notes box, and nothing read for it",
    [await notesDownloadAfterAccess(store.statsId ?? "", sara, "c".repeat(32), admit), asked],
    [false, 0],
  );
  sessions["tomas@example.com"] = [paid("cs_test_tomas0paid01", product)];
  const tomas = await courseAccess(store, course, await signedIn("tomas@example.com"));
  is("paid, thanks page never seen: unknown too (Stripe alone would have opened it)", tomas.state, "unknown");
  const stranger = await courseAccess(store, course, { get: () => undefined });
  is("a visitor is not asked about: closed, with the checkout", [stranger.state, closedDoor(stranger, true, true)], ["closed", "checkout"]);

  part("Taken off the course by the creator: closed, Stripe's answer or not (Claude 1 cloud's LEVE on #3893)");
  // Whether they were taken off is the store's own record, not Stripe's: it is known while Stripe is not, so the
  // page says the course is closed to them, never that their access could not be checked.
  sessions["tina@example.com"] = [paid("cs_test_tina00paid01", product)];
  await recordEnrollment(store, "tina@example.com", product, NOW - 86_400);
  await redis.pipeline([["SADD", `nl:course:${"c".repeat(32)}:blocked`, emailKey("tina@example.com")]]);
  const tina = await courseAccess(store, course, await signedIn("tina@example.com"));
  is("taken off, Stripe unknown: closed, not unknown", tina.state, "closed");
  failing = false;
  is("taken off, Stripe back: still closed", (await courseAccess(store, course, await signedIn("tina@example.com"))).state, "closed");
  failing = true;

  part("Nothing unknown is kept: Stripe back, the next load opens it");
  failing = false;
  is("Stripe back: open", (await courseAccess(store, course, await signedIn("sara@example.com"))).state, "open");

  part("The pages draw the state: a status notice, a reload link, no buying");
  const page = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
  const lesson = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  const note = readFileSync("components/access-unchecked-note.tsx", "utf8");
  is("the course page asks closedDoor what to show", /closedDoor\(access, selling, paypalReady\(store, product\)\)/.test(page), true);
  is("the course page draws the notice for an unchecked door", /door === "unchecked" \?[\s\S]{0,200}<AccessUncheckedNote/.test(page), true);
  is("the course page forgets device places only on forgetsOnDevice", (page.match(/forgetsOnDevice\(access\)/g) ?? []).length, 2);
  is("the lesson page draws the notice in place of the whole-course pitch", /access\.state === "unknown" \?[\s\S]{0,200}<AccessUncheckedNote[\s\S]{0,300}w\.getWhole/.test(lesson), true);
  is("the notice is a status region", /role="status"/.test(note), true);
  is("its retry is a real link that loads the page again", /<a href=\{href\}/.test(note), true);

  part("Said in every buyer language");
  const english = COURSES_WORDS.en;
  is("in plain English", [english.uncheckedTitle, english.uncheckedBody, english.uncheckedRetry], [
    "We couldn't check your access right now",
    "Please try again in a minute.",
    "Check my access again",
  ]);
  for (const [code, words] of Object.entries(COURSES_WORDS)) {
    if (code === "en") continue;
    const all = [words.uncheckedTitle, words.uncheckedBody, words.uncheckedRetry];
    is(`${code}: all three written, none left in English`, all.every((text, i) => text.trim().length > 0 && text !== [english.uncheckedTitle, english.uncheckedBody, english.uncheckedRetry][i]), true);
  }

  done();
}

void main();
