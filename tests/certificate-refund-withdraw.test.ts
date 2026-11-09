/**
 * A course's certificate goes when the payment that gave the course was given back (audit R41, Claude 2 on #3374;
 * owner decision DONO-18, 9 November 2026; CX-123 rule 24).
 *
 * A certificate was withdrawn only by the creator's own press (app/api/store/course/route.ts, action "withdraw"): a
 * buyer refunded in full, or whose bank took the payment back in a lost dispute, lost the course, but their
 * certificate went on standing at its public address, with their name on it. Now the five-minute checkout sweep reads
 * the creator's refunds and lost disputes (lib/certificate-refunds.ts) and withdraws the student's standing certificate
 * of a course whose payment was given back, once the course no longer opens for them (lib/learn.ts,
 * courseStandingFor). A certificate withdrawn this way no longer shows the name on its page.
 *
 * What is checked, through the real sweep (lib/checkout-sweep.ts, sweepCheckouts):
 *   - healthy: a refund that succeeded in full and a lost dispute withdraw the certificate, marked as withdrawn for a
 *     refund, once; another student's certificate stands (control);
 *   - DONO-18: a refund still pending, a failed or canceled one, a partial one, and a full refund made of parts while
 *     one part is still pending withdraw nothing; once every part succeeded, it goes; a dispute won withdraws nothing;
 *   - a student who still holds the course through another purchase keeps the certificate;
 *   - unknown is never "shut": Stripe's list of the student's checkouts, the charge's refunds and the checkout of the
 *     payment read in another shape, and the student's slot read in another shape, withdraw nothing, and the next run
 *     on a whole reading withdraws it;
 *   - an answer about the student's courses kept from before the refund never decides;
 *   - the page and the privacy policy: a certificate withdrawn for a refund shows no name.
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import { readFileSync } from "node:fs";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import * as certificates from "@/lib/certificate";
import { type Certificate, issueCertificate, readCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

process.env.STRIPE_SECRET_KEY = "sk_test_certificate_refund_withdraw";

const OWNER = "teacher@example.com";
const HANDLE = "inkschool";
const ACCOUNT = "acct_1TestCertRefund";
const COURSE_ID = "c".repeat(32);

type Charge = { object: "charge"; id: string; amount: number; amount_refunded: number; refunded: boolean; disputed: boolean };
type Refund = { id: string; object: "refund"; created: number; status: string; amount: number; payment_intent: string; charge: Charge };
type Session = Record<string, unknown> & { id: string; customer_details: { email: string }; payment_intent: { id: string; object: "payment_intent"; latest_charge: Charge } };

const sessions: Session[] = [];
const refunds: Refund[] = [];
const disputes = new Map<string, { status: string }[]>();
const closings: Record<string, unknown>[] = [];
/** When set for a kind of read, its answer in place of the healthy one. */
const garble: Partial<Record<"byEmail" | "byPayment" | "byCharge", () => Response>> = {};

let clock = Math.floor(Date.now() / 1000) - 3_600;
const tick = () => (clock += 5);

const list = (data: unknown[], url: string) => new Response(JSON.stringify({ object: "list", data, has_more: false, url }), { status: 200 });

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (!url.hostname.endsWith("stripe.com")) return new Response(JSON.stringify({ error: "nothing leaves this test" }), { status: 500 });
  const path = url.pathname.replace(/^\/v1/, "");
  const q = url.searchParams;
  if (path === "/refunds") {
    const charge = q.get("charge");
    if (charge) {
      if (garble.byCharge) return garble.byCharge();
      return list(refunds.filter((r) => r.charge.id === charge).sort((a, b) => b.created - a.created), "/v1/refunds");
    }
    const since = Number(q.get("created[gte]") ?? 0);
    return list(refunds.filter((r) => r.created >= since).sort((a, b) => b.created - a.created), "/v1/refunds");
  }
  if (path === "/events") {
    const since = Number(q.get("created[gte]") ?? 0);
    return list(closings.filter((e) => (e.created as number) >= since), "/v1/events");
  }
  if (path === "/disputes") return list(disputes.get(q.get("charge") ?? "") ?? [], "/v1/disputes");
  if (path === "/checkout/sessions") {
    const pi = q.get("payment_intent");
    if (pi) {
      if (garble.byPayment) return garble.byPayment();
      return list(sessions.filter((s) => s.payment_intent.id === pi), "/v1/checkout/sessions");
    }
    const email = q.get("customer_details[email]");
    if (email) {
      if (garble.byEmail) return garble.byEmail();
      return list(sessions.filter((s) => s.customer_details.email === email), "/v1/checkout/sessions");
    }
    return list([], "/v1/checkout/sessions");
  }
  if (path.startsWith("/payment_intents/")) return new Response(JSON.stringify({ id: path.split("/")[2], object: "payment_intent", metadata: {} }), { status: 200 });
  return list([], path);
}) as typeof fetch;

const GARBLED: [string, () => Response][] = [
  ["no list (an empty object)", () => new Response("{}", { status: 200 })],
  ["data not a list", () => new Response(JSON.stringify({ object: "list", data: "none", has_more: false }), { status: 200 })],
  ["has_more missing", () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })],
  ["Stripe failing (500)", () => new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 })],
];

let n = 0;
/** A paid checkout of the course by `email`, for 4,900 cents. */
function buy(email: string, product: string): Session {
  n += 1;
  const tag = String(n).padStart(10, "0");
  const charge: Charge = { object: "charge", id: `ch_test${tag}`, amount: 4900, amount_refunded: 0, refunded: false, disputed: false };
  const session: Session = {
    id: `cs_test_cert${tag}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: tick(),
    customer_details: { email },
    metadata: { store: HANDLE, product },
    payment_intent: { id: `pi_test${tag}`, object: "payment_intent", latest_charge: charge },
  };
  sessions.push(session);
  return session;
}

/** A refund of `amount` on the session's charge, in `status`; the charge shows what Stripe counts back, pending parts too. */
function refund(session: Session, amount: number, status: string): Refund {
  n += 1;
  const charge = session.payment_intent.latest_charge;
  if (status !== "failed" && status !== "canceled") {
    charge.amount_refunded = Math.min(charge.amount, charge.amount_refunded + amount);
    charge.refunded = charge.amount_refunded >= charge.amount;
  }
  const row: Refund = { id: `re_test${String(n).padStart(10, "0")}`, object: "refund", created: tick(), status, amount, payment_intent: session.payment_intent.id, charge };
  refunds.push(row);
  return row;
}

/** Stripe moving a refund on: the charge as it then reads. */
function settle(row: Refund, status: string): void {
  if ((status === "failed" || status === "canceled") && row.status !== "failed" && row.status !== "canceled") {
    row.charge.amount_refunded -= row.amount;
    row.charge.refunded = false;
  }
  row.status = status;
}

/** A dispute on the session's charge that Stripe closed as `status`. */
function closeDispute(session: Session, status: "lost" | "won"): void {
  n += 1;
  const charge = session.payment_intent.latest_charge;
  charge.disputed = true;
  disputes.set(charge.id, [{ status }]);
  closings.unshift({
    id: `evt_test${String(n).padStart(10, "0")}`,
    object: "event",
    type: "charge.dispute.closed",
    created: tick(),
    data: { object: { id: `dp_test${String(n).padStart(10, "0")}`, object: "dispute", status, charge: charge.id, payment_intent: session.payment_intent.id } },
  });
}

async function sweep(): Promise<void> {
  await sweepCheckouts(Date.now() + 20_000);
}

const original = redis.pipeline.bind(redis);
/** Answers the first single HGET of the course's certificate slots with `reply`, everything else as Redis does. */
function slotAnswers(reply: unknown): void {
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!used && commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === `nl:course:${COURSE_ID}:certs`) {
      used = true;
      return reply;
    }
    return original(commands);
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Ink School", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Ink Basics", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductCourse(OWNER, made.product.id, { id: COURSE_ID, lessons: 3 });
  const store = (await storeForEmail(OWNER))!;
  const product = made.product.id;
  const course = { id: COURSE_ID, certificate: true, startsAt: null, modules: [] } as unknown as Course;

  /** A student who bought the course and was issued its certificate. */
  const student = async (email: string): Promise<{ session: Session; id: string }> => {
    const session = buy(email, product);
    const issued = await issueCertificate({ store: storeKey(store), productId: product, course, title: "Ink Basics", creator: "Ink School", email, who: emailKey(email), name: `Student ${email.split("@")[0]}`, room: ROOM });
    if (!issued.ok) throw new Error("not issued");
    return { session, id: issued.certificate.id };
  };
  const record = async (id: string): Promise<Certificate | null> => readCertificate(id);
  const withdrawn = async (id: string): Promise<boolean> => ((await record(id))?.withdrawnAt ?? 0) > 0;
  const forRefund = async (id: string): Promise<unknown> => ((await record(id)) as (Certificate & { withdrawnFor?: unknown }) | null)?.withdrawnFor;
  const publicName = (certificates as unknown as { publicName?: (c: Certificate) => string | null }).publicName;
  const shown = async (id: string): Promise<string | null | "no publicName"> => {
    const c = await record(id);
    return !c ? null : publicName ? publicName(c) : "no publicName";
  };

  part("Healthy: a refund that succeeded in full withdraws the certificate, once; others stand");
  const ana = await student("ana@example.com");
  const bea = await student("bea@example.com");
  await sweep();
  is("nothing given back: Ana's certificate stands (control)", await withdrawn(ana.id), false);
  is("nothing given back: Bea's certificate stands (control)", await withdrawn(bea.id), false);
  refund(bea.session, 4900, "succeeded");
  await sweep();
  is("Bea refunded in full, the refund succeeded: her certificate is withdrawn", await withdrawn(bea.id), true);
  is("marked as withdrawn for a refund", await forRefund(bea.id), "refund");
  is("its page shows no name", await shown(bea.id), null);
  is("Ana's certificate still stands", await withdrawn(ana.id), false);
  is("Ana's page still shows her name", await shown(ana.id), "Student ana");
  const at = (await record(bea.id))?.withdrawnAt ?? 0;
  await sweep();
  is("read again: withdrawn once, at the same moment", [at > 0, (await record(bea.id))?.withdrawnAt], [true, at]);

  part("DONO-18: only a refund that succeeded, or a dispute lost, takes the certificate");
  const cid = await student("cid@example.com");
  const pending = refund(cid.session, 4900, "pending");
  await sweep();
  is("a full refund still pending: the certificate stands", await withdrawn(cid.id), false);
  settle(pending, "succeeded");
  await sweep();
  is("the same refund, now succeeded: withdrawn", await withdrawn(cid.id), true);

  const dan = await student("dan@example.com");
  const failing = refund(dan.session, 4900, "pending");
  await sweep();
  settle(failing, "failed");
  await sweep();
  is("a full refund that failed: the certificate stands", await withdrawn(dan.id), false);
  const eve = await student("eve@example.com");
  const canceling = refund(eve.session, 4900, "pending");
  await sweep();
  settle(canceling, "canceled");
  await sweep();
  is("a full refund that was canceled: the certificate stands", await withdrawn(eve.id), false);

  const fay = await student("fay@example.com");
  refund(fay.session, 2000, "succeeded");
  await sweep();
  is("a partial refund that succeeded: the certificate stands", await withdrawn(fay.id), false);
  const rest = refund(fay.session, 2900, "pending");
  await sweep();
  is("a full refund made of parts, one still pending (the charge already reads refunded): stands", await withdrawn(fay.id), false);
  settle(rest, "succeeded");
  await sweep();
  is("every part succeeded: withdrawn", await withdrawn(fay.id), true);

  const gus = await student("gus@example.com");
  closeDispute(gus.session, "lost");
  await sweep();
  is("a dispute lost: withdrawn", await withdrawn(gus.id), true);
  is("a dispute lost: marked as for a refund", await forRefund(gus.id), "refund");
  const hal = await student("hal@example.com");
  closeDispute(hal.session, "won");
  await sweep();
  is("a dispute won by the creator: the certificate stands", await withdrawn(hal.id), false);

  part("A student who still holds the course another way keeps the certificate");
  const ivy = await student("ivy@example.com");
  buy("ivy@example.com", product);
  refund(ivy.session, 4900, "succeeded");
  await sweep();
  is("bought twice, one refunded: the course still opens, the certificate stands", await withdrawn(ivy.id), false);

  part("Unknown is never shut: nothing is withdrawn on an answer that cannot be read, and the next run does it");
  for (const [label, answer] of GARBLED) {
    const s = await student(`list${n}@example.com`);
    refund(s.session, 4900, "succeeded");
    garble.byEmail = answer;
    await sweep();
    is(`the student's checkouts, ${label}: stands`, await withdrawn(s.id), false);
    delete garble.byEmail;
    await sweep();
    is(`the student's checkouts read whole again (${label}): withdrawn`, await withdrawn(s.id), true);
  }
  for (const [label, answer] of GARBLED) {
    const s = await student(`charge${n}@example.com`);
    refund(s.session, 4900, "succeeded");
    garble.byCharge = answer;
    await sweep();
    is(`the charge's refunds, ${label}: stands`, await withdrawn(s.id), false);
    delete garble.byCharge;
    await sweep();
    is(`the charge's refunds read whole again (${label}): withdrawn`, await withdrawn(s.id), true);
  }
  for (const [label, answer] of GARBLED) {
    const s = await student(`sale${n}@example.com`);
    refund(s.session, 4900, "succeeded");
    garble.byPayment = answer;
    await sweep();
    is(`the payment's checkout, ${label}: stands`, await withdrawn(s.id), false);
    delete garble.byPayment;
    await sweep();
    is(`the payment's checkout read whole again (${label}): withdrawn`, await withdrawn(s.id), true);
  }
  for (const [label, reply] of [
    ["a number", [17]],
    ["an object", [{ id: "x" }]],
    ["two replies to one command", ["a", "b"]],
    ["no list at all", null],
  ] as const) {
    const s = await student(`slot${n}@example.com`);
    refund(s.session, 4900, "succeeded");
    slotAnswers(reply);
    try {
      await sweep();
    } finally {
      redis.pipeline = original;
    }
    is(`the student's slot read as ${label}: stands`, await withdrawn(s.id), false);
    await sweep();
    is(`the slot read exactly again (${label}): withdrawn`, await withdrawn(s.id), true);
  }

  part("An answer about the student's courses kept from before the refund never decides");
  const kim = await student("kim@example.com");
  const cache = `nl:learn:paid:${storeKey(store)}:${emailKey("kim@example.com")}`;
  await original([["SET", cache, JSON.stringify({ p: { [product]: kim.session.created }, x: [], r: [] }), "EX", 600]]);
  refund(kim.session, 4900, "succeeded");
  await sweep();
  is("kept as open ten minutes ago, refunded since: withdrawn", await withdrawn(kim.id), true);

  part("The page and the policy say what is shown");
  const page = readFileSync("app/[handle]/certificate/[id]/page.tsx", "utf8");
  is("the page's title and description take the name only through publicName", /title:[^\n]*publicName|publicName\([^)]*\)[\s\S]{0,400}title:/.test(page) && !/w\.metaCert\(certificate\.name/.test(page), true);
  is("the sheet with the name is drawn only when publicName gives one", /publicName\(certificate\)/.test(page) && !/<p className="cert-name">\{certificate\.name\}<\/p>/.test(page), true);
  const words = readFileSync("lib/buyer-words/courses.ts", "utf8");
  is("every language says why a certificate withdrawn for a refund was withdrawn", (words.match(/withdrawnRefundBody:/g) ?? []).length, 7);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  is("the privacy policy says a certificate withdrawn after a refund or a lost dispute no longer shows the name", /refunded in full or lost in a dispute[^.]*no longer shows the name/.test(privacy), true);
  const sweepSource = readFileSync("lib/checkout-sweep.ts", "utf8");
  is("the checkout sweep runs the certificates' refund pass", /withdrawRefundedCertificates\(store, deadline\)/.test(sweepSource), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
