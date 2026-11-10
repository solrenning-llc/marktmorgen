/**
 * 560 [AS1], unit 3: the course's "Next step" set in the studio and shown on
 * the course's page. Each case fails on the wrong behavior:
 *
 *   - the studio's field saves through the route with the very body it sends,
 *     and the route refuses the course itself, a product of no store of the
 *     creator's, and a line that presses, with the reason and its sentence;
 *   - kept on the course and read back, a malformed kept value dropped;
 *   - on the course's page, the card is shown only to a student who does not
 *     have the product, and nothing is read from the creator's Stripe account
 *     when the card would not show anyway (no choice, a draft, a "No thanks"
 *     kept in the browser); a Stripe answer that fails shows no card;
 *   - the card says the product, its price and the creator's line, with a real
 *     "No thanks" button, in every store language.
 *
 * Synthetic records and a stand-in Stripe only: nothing real is charged, sent or read.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { editCourse, emptyCourse, parseCourse, readCourse } from "@/lib/course";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { CourseNextStep } from "@/components/course-next-step";
import { CourseNextStepCard } from "@/components/course-next-step-card";
import { NEXT_STEP_NO_SECONDS, nextStepCookie, nextStepFor } from "@/lib/course-next-step";
import { MAX_NEXT_STEP_LINE, NEXT_STEP_PROBLEMS } from "@/lib/course-next-step-rules";

const OWNER = "nextstep-owner@example.test";
const STUDENT = "nextstep-student@example.test";
const ACCOUNT = "acct_1TestNextStep01";
const NOW = Math.floor(Date.now() / 1000);

/** What the stand-in Stripe answers for the student's checkouts: the products bought, or a failure. */
let bought: string[] | "fail" = [];
let stripeCalls = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  assert.equal(url.hostname, "api.stripe.com");
  assert.equal(init?.method ?? "GET", "GET", "nothing is written to the creator's Stripe account");
  stripeCalls += 1;
  if (bought === "fail") return answer({ error: { type: "api_error", message: "synthetic failure" } }, 500);
  if (url.pathname === "/v1/checkout/sessions") {
    const data = bought.map((product, i) => ({
      object: "checkout.session",
      id: `cs_test_NextStep${String(i).padStart(8, "0")}`,
      status: "complete",
      payment_status: "paid",
      created: NOW - 60,
      customer: null,
      customer_details: { email: STUDENT },
      metadata: { store: "nextstep", product },
    }));
    return answer({ object: "list", data, has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

beforeEach(() => {
  redis.clear();
  bought = [];
  stripeCalls = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_next_step_only";
});

/** A store with a course and two other products on sale, and the owner's session. */
async function shop() {
  await claimHandle(OWNER, "nextstep", "Next Step Studio", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_NextStepOwner", subscriptionId: "sub_NextStepOwner", active: true, tier: "scale", period: paidPeriod() });
  const made = async (title: string) => {
    const added = await addProduct(OWNER, title, "", "49", null);
    assert.ok(added.ok, JSON.stringify(added));
    return added.product.id;
  };
  const course = await made("Watercolor basics");
  const advanced = await made("Advanced watercolor");
  const guide = await made("Color guide");
  for (const id of [advanced, guide]) assert.ok((await setProductLink(OWNER, id, "https://example.test/files")).ok);
  const session = await openSession(OWNER);
  const post = async (body: Record<string, unknown>) => {
    const response = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; reason?: string; message?: string } };
  };
  assert.equal((await post({ action: "enable", id: course })).body.ok, true);
  const courseId = (await readListing((await storeForEmail(OWNER))!, course))!.course!.id;
  return { course, advanced, guide, courseId, post };
}

test("the choice is kept on the course and read back; a malformed kept value is dropped", () => {
  const course = emptyCourse();
  const set = editCourse(course, { op: "next-step", step: { productId: "advanced0001", line: "Go deeper when you are ready." } });
  assert.ok(set.ok);
  assert.deepEqual(parseCourse(JSON.stringify(set.course))?.nextStep, { productId: "advanced0001", line: "Go deeper when you are ready." });
  const cleared = editCourse(set.course, { op: "next-step", step: null });
  assert.ok(cleared.ok && !("nextStep" in cleared.course));
  assert.equal(parseCourse(JSON.stringify({ ...course, nextStep: { productId: "NOT A ID!", line: "x" } }))?.nextStep, undefined);
  assert.equal(parseCourse(JSON.stringify(course))?.nextStep, undefined, "a course saved before it existed has none");
});

test("the studio's field saves through the route with the body it sends; the route refuses what the rules refuse, with the sentence", async () => {
  const { course, advanced, courseId, post } = await shop();
  const field = readFileSync("components/course-next-step.tsx", "utf8");
  assert.match(field, /action: "next-step", productId: picked, line: picked \? line : ""/, "the body the field sends");

  const saved = await post({ id: course, action: "next-step", productId: advanced, line: "  When you are ready,  go deeper.  " });
  assert.deepEqual([saved.status, saved.body.ok], [200, true]);
  assert.deepEqual((await readCourse(courseId))?.nextStep, { productId: advanced, line: "When you are ready, go deeper." });

  const pressing = await post({ id: course, action: "next-step", productId: advanced, line: "Join now, spots are limited" });
  assert.deepEqual([pressing.status, pressing.body.error, pressing.body.reason, pressing.body.message], [400, "next_step", "pressure", NEXT_STEP_PROBLEMS.pressure]);
  assert.deepEqual((await readCourse(courseId))?.nextStep?.line, "When you are ready, go deeper.", "a refused line changes nothing kept");

  const self = await post({ id: course, action: "next-step", productId: course, line: "" });
  assert.deepEqual([self.status, self.body.reason], [400, "self"]);
  const foreign = await post({ id: course, action: "next-step", productId: "elsewhere0001", line: "" });
  assert.deepEqual([foreign.status, foreign.body.reason], [400, "product"], "a product of no store of the creator's");

  const removed = await post({ id: course, action: "next-step", productId: "", line: "" });
  assert.deepEqual([removed.status, removed.body.ok], [200, true]);
  assert.equal((await readCourse(courseId))?.nextStep, undefined);

  const route = readFileSync("app/api/store/course/route.ts", "utf8");
  const limit = Number(/const action = text\(body\.action, (\d+)\)/.exec(route)?.[1] ?? 0);
  assert.ok("next-step".length <= limit, "the action fits the length the route reads");
});

test("the studio's field: labelled, its count said, the product list the store's own", () => {
  const html = renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {} } as never }, createElement(CourseNextStep, { productId: "course000001", current: { productId: "advanced0001", line: "Go deeper." }, choices: [{ id: "advanced0001", title: "Advanced watercolor" }], maxLine: MAX_NEXT_STEP_LINE })),
  );
  assert.match(html, /<label[^>]*>[\s\S]*Product to suggest next[\s\S]*<select[\s\S]*<\/label>/);
  assert.match(html, /<option value="">None: show no next step<\/option>/);
  assert.match(html, /<option value="advanced0001" selected="">Advanced watercolor<\/option>/);
  assert.match(html, /Your line \(optional\)[\s\S]*<textarea/);
  assert.ok(html.includes(`10 of ${MAX_NEXT_STEP_LINE} characters`), "the count, in words");
  const field = readFileSync("components/course-next-step.tsx", "utf8");
  assert.ok(!field.includes("course-next-step-rules\""), "the page loads none of the rules' word lists");
});

test("on the course's page the card shows only to a student without the product, and nothing is read from Stripe when it would not show", async () => {
  const { course, advanced, courseId, post } = await shop();
  const store = () => storeForEmail(OWNER).then((s) => s!);
  const at = async (dismissed = false) => nextStepFor({ store: await store(), course: (await readCourse(courseId))!, courseProductId: course, email: STUDENT, dismissed });

  assert.equal(await at(), null, "no choice: no card");
  assert.equal(stripeCalls, 0, "and nothing read");

  assert.equal((await post({ id: course, action: "next-step", productId: advanced, line: "Go deeper." })).body.ok, true);
  assert.equal((await at())?.id, advanced, "a student without it sees it");
  assert.ok(stripeCalls > 0, "what they have was read for it");

  stripeCalls = 0;
  assert.equal(await at(true), null, "a No thanks kept in this browser");
  assert.equal(stripeCalls, 0, "and nothing read for it");

  bought = [advanced];
  assert.equal(await at(), null, "a student who has it");
  bought = "fail";
  assert.equal(await at(), null, "what they have could not be read: no card, never a guess");

  bought = [];
  assert.ok((await setProductHidden(OWNER, advanced, true)).ok);
  stripeCalls = 0;
  assert.equal(await at(), null, "a draft is never suggested");
  assert.equal(stripeCalls, 0, "and nothing read for it");
});

test("the card: the product, its price and the creator's line, a real No thanks button, kept in a cookie that holds only the answer", () => {
  const w = coursesWords("en");
  const html = renderToStaticMarkup(
    createElement(CourseNextStepCard, {
      cookie: nextStepCookie("a".repeat(32)),
      seconds: NEXT_STEP_NO_SECONDS,
      href: "/@nextstep/p/advanced-watercolor",
      title: "Advanced watercolor",
      price: "$49",
      line: "Go deeper.",
      words: { label: w.nextStepLabel, see: w.nextStepSee("Advanced watercolor"), noThanks: w.nextStepNoThanks, done: w.nextStepNoThanksDone },
    }),
  );
  assert.match(html, /<section[^>]*aria-labelledby="next-step-title"/);
  assert.match(html, /<h2 id="next-step-title"[^>]*>Advanced watercolor<\/h2>/);
  assert.ok(html.includes(">$49<") && html.includes(">Go deeper.<"));
  assert.match(html, /<a href="\/@nextstep\/p\/advanced-watercolor" class="btn st-btn">See Advanced watercolor<\/a>/);
  assert.match(html, /<button type="button"[^>]*aria-describedby="next-step-title"[^>]*>No thanks<\/button>/);
  assert.ok(!/%|\d+ (people|students|left)|only|hurry/i.test(html.replace(">$49<", "")), "nothing that presses");
  const card = readFileSync("components/course-next-step-card.tsx", "utf8");
  assert.ok(card.includes("document.cookie = `${cookie}=1; Path=/; Max-Age=${seconds}; SameSite=Lax${secure}`"), "the cookie holds only 1");
  const page = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
  assert.ok(page.includes('dismissed: jar.get(nextCookie)?.value === "1"'), "the page reads the No thanks before anything else");
  assert.ok(readFileSync("app/privacy/page.tsx", "utf8").includes("<code>nl_ns_</code>"), "the privacy policy names the cookie");
});

test("every store language says the card in its own words", () => {
  const en = coursesWords("en");
  for (const language of LANGUAGE_CODES) {
    const w = coursesWords(language);
    assert.ok(w.nextStepSee("T").includes("T") && w.nextStepLabel && w.nextStepNoThanks && w.nextStepNoThanksDone, language);
    if (language !== "en") assert.ok(w.nextStepLabel !== en.nextStepLabel && w.nextStepNoThanks !== en.nextStepNoThanks && w.nextStepNoThanksDone !== en.nextStepNoThanksDone, `${language}: not English`);
  }
});
