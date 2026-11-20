/**
 * 662 [OF1], unit 2: the buyer's own pages of a store switched off after a
 * report (lib/takedown.ts, `store.suspended`). What the buyer already has stays
 * theirs: the course they bought, the community they are in, their membership's
 * cancel button, their orders. What the store no longer does is not offered:
 * no way to buy (the products that open the community or an event, the free
 * lesson that leads to a purchase, "See" a product, "Renew your membership",
 * the prices a gone price points to) and no way to write to the store (its
 * email on the page that asks why a member leaves). Proposals still to sign
 * and the review button lead to pages the switch-off closes (unit 1), so they
 * are not shown either.
 *
 * Each through the real page, route or card, with a synthetic store, switched
 * off with noteTakedown and then back on, which brings everything back.
 */
import { createElement } from "react";
import { NextRequest } from "next/server";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import CommunityPage from "@/app/[handle]/community/page";
import EventPage from "@/app/[handle]/community/events/[event]/page";
import CoursePage from "@/app/[handle]/course/[product]/page";
import LessonPage from "@/app/[handle]/course/[product]/[lesson]/page";
import ManagePage from "@/app/[handle]/manage/page";
import LeavePage from "@/app/[handle]/manage/leave/page";
import MovePage from "@/app/[handle]/move/[product]/page";
import RenewPage from "@/app/[handle]/renew/[product]/page";
import { PurchaseCard } from "@/components/purchase-card";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import type { Purchase } from "@/lib/buyer-orders";
import { waitingFor } from "@/lib/buyer-waiting";
import { coursesWords } from "@/lib/buyer-words/courses";
import { membershipWords } from "@/lib/buyer-words/membership";
import { moveWords } from "@/lib/buyer-words/move";
import { ordersWords } from "@/lib/buyer-words/orders";
import { communityWords } from "@/lib/buyer-words/community";
import { freshConfig, readConfig, saveConfig } from "@/lib/community";
import { createEvent } from "@/lib/community-events";
import { type Course, saveCourse } from "@/lib/course";
import { emailKey, storeKey } from "@/lib/learn";
import { inviteMembers, readInvite } from "@/lib/move-members";
import { personKey } from "@/lib/person-key";
import { cardOf } from "@/lib/purchase-cards";
import { readProduct } from "@/lib/catalog";
import {
  type Store,
  addOption,
  addProduct,
  claimHandle,
  ensureStatsId,
  ensureStoreId,
  noteTakedown,
  removeOption,
  setCommunity,
  setLeaving,
  setProductCourse,
  setStripeAccount,
  setSubscription,
  storeForEmail,
} from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "of1-buyers@example.com";
const STUDENT = "of1-student@example.com";
const HANDLE = "of1buyers";
const ACCOUNT = "acct_1TestOfOne001";
const BASE = "https://marktmorgen.com";
const DAY = 86_400;

let clubId = "";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_of1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  // The member's one running membership, as Stripe lists it for the manage pages (lib/membership-manage.ts, subsOf).
  if (path === "/subscriptions" && method === "GET") {
    return answer({
      object: "list",
      has_more: false,
      data: [
        {
          id: "sub_OfOneMember01",
          status: "active",
          customer: "cus_OfOneMember1",
          metadata: { store: HANDLE, product: clubId },
          items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 20 * DAY, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
        },
      ],
    });
  }
  // Nothing else bought with Stripe by this address.
  if (path === "/checkout/sessions" && method === "GET") return answer({ object: "list", has_more: false, data: [] });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A page drawn to HTML, as a browser gets it; or where it sent the visitor instead. */
async function html(run: () => Promise<unknown>): Promise<string> {
  try {
    const node = await run();
    // Inside the app router, as Next draws every page (the event's door timer reads it).
    const stream = await renderToReadableStream(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, prefetch() {} } as never }, node as React.ReactElement), { onError: () => {} });
    await stream.allReady;
    return await new Response(stream).text();
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    if (digest) return `thrown ${digest}`;
    throw error;
  }
}

const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_of1_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_of1_only_a_stand_in";
  redis.clear();

  await claimHandle(OWNER, HANDLE, "Clay House", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_OfOneOwner01", subscriptionId: "sub_OfOneOwner01", active: true, tier: "creator", period: paidPeriod() });

  // A course with a free preview lesson.
  const courseMade = await addProduct(OWNER, "Glaze course", "", "49", null);
  if (!courseMade.ok) throw new Error("no course product");
  const courseId = courseMade.product.id;
  const course = {
    id: "e".repeat(32),
    certificate: false,
    startsAt: null,
    modules: [
      {
        id: "module000001",
        title: "Glazes",
        dripDays: 0,
        lessons: [
          { id: "lesson000001", title: "Free first look", preview: true, video: null, files: [], link: null, hasBody: false, quiz: null },
          { id: "lesson000002", title: "Paid lesson", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null },
        ],
      },
    ],
  } as unknown as Course;
  await saveCourse(course, ROOM, true);
  const attached = await setProductCourse(OWNER, courseId, { id: course.id, lessons: 2 });
  if (!attached.ok) throw new Error(`no course: ${attached.reason}`);

  // A course that opens a module a month after joining, its free preview inside that module (Claude 4 on #3203).
  const kilnMade = await addProduct(OWNER, "Kiln course", "", "59", null);
  if (!kilnMade.ok) throw new Error("no drip course product");
  const kilnId = kilnMade.product.id;
  const kiln = {
    id: "d".repeat(32),
    certificate: false,
    startsAt: null,
    modules: [
      {
        id: "module000011",
        title: "Firing",
        dripDays: 0,
        lessons: [{ id: "kiln00000001", title: "First firing", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null }],
      },
      {
        id: "module000012",
        title: "Later firings",
        dripDays: 30,
        lessons: [
          { id: "kiln00000002", title: "Kiln preview", preview: true, video: null, files: [], link: null, hasBody: false, quiz: null },
          { id: "kiln00000003", title: "Kiln paid", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null },
        ],
      },
    ],
  } as unknown as Course;
  await saveCourse(kiln, ROOM, true);
  const kilnAttached = await setProductCourse(OWNER, kilnId, { id: kiln.id, lessons: 3 });
  if (!kilnAttached.ok) throw new Error(`no drip course: ${kilnAttached.reason}`);

  // A membership with one price option, for the moving-in, come-back and leave pages.
  const clubMade = await addProduct(OWNER, "Studio club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!clubMade.ok) throw new Error("no membership product");
  clubId = clubMade.product.id;
  await addOption(OWNER, clubId, "Basic", "15");
  await setLeaving(OWNER, { on: true, reasons: ["missing_features"] });

  // The community, opened by both products.
  await setCommunity(OWNER, true);
  let store = (await storeForEmail(OWNER)) as Store;
  const communityId = store.community!.id;
  await saveConfig(communityId, { ...freshConfig(store.name), access: [courseId, clubId] });
  const config = (await readConfig(communityId))!;
  const event = await createEvent(store, { title: "Live critique", about: "", start: Date.now() + 2 * DAY * 1000, minutes: 60, tz: "UTC", cap: 0, where: "room", link: "", meet: null, only: [courseId] });
  if (!event.ok) throw new Error(`no event: ${event.reason}`);
  const eventId = event.event.id;

  // The student: signed in with their address, holding the course (lib/learn.ts, the paid cache) and the
  // community's ticket through the membership (lib/community-access.ts, the kept answer), not the event's course.
  const session = await openSession(STUDENT);
  const started = Math.floor(Date.now() / 1000) - DAY;
  await redis.pipeline([
    ["SET", `nl:learn:paid:${storeKey(store)}:${emailKey(STUDENT)}`, JSON.stringify({ p: { [courseId]: started, [kilnId]: started }, x: [], r: [] }), "EX", 600],
    ["SET", `nl:cm:${communityId}:ok:${emailKey(STUDENT)}`, JSON.stringify({ v: config.v, ok: true }), "EX", 600],
  ]);

  const asked = (path: string, who: "visitor" | "student" = "visitor") =>
    answering(new NextRequest(`${BASE}${path}`, { headers: who === "student" ? { cookie: `${SESSION_COOKIE}=${session}` } : {} }));
  const gate = () => {
    asked(`/@${HANDLE}/community`);
    return html(() => CommunityPage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve({}) }));
  };
  const eventPage = () => {
    asked(`/@${HANDLE}/community/events/${eventId}`, "student");
    return html(() => EventPage({ params: Promise.resolve({ handle: `@${HANDLE}`, event: eventId }), searchParams: Promise.resolve({}) } as never));
  };
  const front = (who: "visitor" | "student") => {
    asked(`/@${HANDLE}/course/${courseId}`, who);
    return html(() => CoursePage({ params: Promise.resolve({ handle: `@${HANDLE}`, product: courseId }), searchParams: Promise.resolve({}) }));
  };
  const lesson = (who: "visitor" | "student", lessonId: string) => {
    asked(`/@${HANDLE}/course/${courseId}/${lessonId}`, who);
    return html(() => LessonPage({ params: Promise.resolve({ handle: `@${HANDLE}`, product: courseId, lesson: lessonId }), searchParams: Promise.resolve({}) }));
  };

  const kilnLesson = (who: "visitor" | "student", lessonId: string) => {
    asked(`/@${HANDLE}/course/${kilnId}/${lessonId}`, who);
    return html(() => LessonPage({ params: Promise.resolve({ handle: `@${HANDLE}`, product: kilnId, lesson: lessonId }), searchParams: Promise.resolve({}) }));
  };
  const shownOr = (drawn: string) => (drawn.startsWith("redirect") ? drawn : "shown");

  // The member's manage link (lib/membership-manage.ts, as the emailed one is kept).
  const token = "c".repeat(64);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0, 40);
  await redis.pipeline([["SET", `nl:manage:link:${hash}`, JSON.stringify({ a: ACCOUNT, c: "cus_OfOneMember1", h: HANDLE })]]);
  const manage = () => {
    asked(`/@${HANDLE}/manage`);
    return html(() => ManagePage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve({ token }) }));
  };
  const leave = () => {
    asked(`/@${HANDLE}/manage/leave`);
    return html(() => LeavePage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve({ token, sub: "sub_OfOneMember01", why: "missing_features" }) }));
  };

  // A member invited to move in at the Basic price, which is then removed: the price named is gone.
  const basic = (await readProduct(store, clubId))!.options[0].id;
  const [field] = await inviteMembers(store, "job_of1buyers", [{ email: "dana@example.com", productId: clubId, option: basic, renews: Math.floor(Date.now() / 1000) + 20 * DAY }]);
  if (!field) throw new Error("not invited");
  const invite = (await readInvite(store.statsId!, field))!;
  await removeOption(OWNER, basic);
  const move = () => {
    asked(`/@${HANDLE}/move/${clubId}`);
    return html(() => MovePage({ params: Promise.resolve({ handle: `@${HANDLE}`, product: clubId }), searchParams: Promise.resolve({ k: invite.t }) }));
  };
  // A come-back offer for the gone price (lib/winback-send.ts, as the weekly sweep keeps it).
  const back = "f".repeat(40);
  await redis.pipeline([["SET", `nl:wb:link:${back}`, JSON.stringify({ s: store.statsId, e: "dana@example.com", p: clubId, o: basic, c: "co_OfOneBack01", pc: 25, m: 1 }), "EX", 14 * DAY]]);
  const renew = (query: Record<string, string>) => {
    asked(`/@${HANDLE}/renew/${clubId}`);
    return html(() => RenewPage({ params: Promise.resolve({ handle: `@${HANDLE}`, product: clubId }), searchParams: Promise.resolve(query) }));
  };

  // A proposal emailed to the buyer, still to sign (lib/buyer-waiting.ts, the orders page's list).
  const BUYER = "ana@example.com";
  const now = Date.now();
  const agreement = {
    id: "a1".padEnd(32, "0"), sid: store.sid, kind: "proposal", email: BUYER, name: "", createdAt: now - 1000, expiresAt: now + 10 * DAY * 1000, state: "open",
    versions: [{ n: 1, sha256: "a".repeat(64), title: "Kiln repair", createdAt: now - 1000, signature: null }], sent: [now - 1000], failed: "", payRequest: "", copies: 0, closedAt: 0,
  };
  await redis.pipeline([
    ["SET", `nl:agree:r:${agreement.id}`, JSON.stringify(agreement)],
    ["SET", `nl:agree:v:${agreement.id}:1`, "Repair the kiln."],
    ["SADD", `nl:agree:p:${store.sid}:${personKey(store.sid!, BUYER)}`, agreement.id],
  ]);

  // An ended membership bought here, and a course order that can be reviewed (lib/purchase-cards.ts, as the orders page draws it).
  const ended = { reference: "cs_test_of1ended", kind: "sale", title: "Studio club", option: null, paidAt: started, member: true, ended: true, productId: clubId, courseProduct: null, main: null, items: null, added: [] } as unknown as Purchase;
  const reviewable = { reference: "cs_test_of1course", kind: "sale", title: "Glaze course", option: null, paidAt: started, member: false, ended: false, productId: courseId, courseProduct: courseId, main: null, items: null, added: [] } as unknown as Purchase;
  const extras = { feeds: new Map(), keys: new Map(), reviewing: new Set([courseId]), progress: new Map() };
  const card = (purchase: Purchase) => renderToStaticMarkup(createElement(PurchaseCard, { card: cardOf(store, purchase, "t".repeat(64), extras), language: store.language }));

  const cw = coursesWords(store.language);
  const mw = membershipWords(store.language);
  const vw = moveWords(store.language);
  const ow = ordersWords(store.language);
  const kw = communityWords(store.language);
  const productLink = `href="/@${HANDLE}/p/`;

  /** Everything checked, the same way, with the store on and then off. */
  const look = async () => {
    store = (await storeForEmail(OWNER)) as Store;
    const shownGate = await gate();
    const shownEvent = await eventPage();
    const visitorFront = await front("visitor");
    const studentFront = await front("student");
    const shownManage = await manage();
    const shownLeave = await leave();
    const shownMove = await move();
    const plainRenew = await renew({});
    const goneRenew = await renew({ back });
    const waiting = await waitingFor(store, BUYER);
    const endedCard = card(ended);
    const courseCard = card(reviewable);
    const kilnFirst = await kilnLesson("student", "kiln00000001");
    const kilnPreview = await kilnLesson("student", "kiln00000002");
    return {
      gate: {
        products: shownGate.includes(productLink) && shownGate.includes("Glaze course") && shownGate.includes("Studio club"),
        memberSignIn: shownGate.includes('action="/api/store/community/link"'),
      },
      event: {
        products: shownEvent.includes(productLink) && shownEvent.includes("Glaze course"),
        gone: shownEvent.includes(escaped(kw.productGone(store.name))),
        page: shownEvent.includes("Live critique"),
      },
      course: {
        freeLesson: visitorFront.includes(escaped(cw.tryFree("Free first look"))),
        previewToVisitor: await (async () => { const drawn = await lesson("visitor", "lesson000001"); return drawn.startsWith("redirect") ? drawn : "shown"; })(),
        buyerSignIn: visitorFront.includes('action="/api/store/course/link"'),
        studentFront: studentFront.startsWith("redirect") ? studentFront : "shown",
        studentLesson: (await lesson("student", "lesson000002")).startsWith("redirect") ? "redirect" : "shown",
      },
      drip: {
        // The first lesson's way on (the done-and-next form, or the Next button) leads to the preview in the module still shut.
        nextIsPreview: kilnFirst.includes('name="next" value="kiln00000002"') || kilnFirst.includes(`href="/@${HANDLE}/course/${kilnId}/kiln00000002"`),
        studentPreview: shownOr(kilnPreview),
        studentShut: shownOr(await kilnLesson("student", "kiln00000003")),
        visitorPreview: shownOr(await kilnLesson("visitor", "kiln00000002")),
      },
      manage: {
        cancel: shownManage.includes('action="/api/store/manage/cancel"') || shownManage.includes("/manage/leave?"),
        card: shownManage.includes('action="/api/store/manage/open"'),
      },
      leave: {
        contact: shownLeave.includes("mailto:") || shownLeave.includes(`/@${HANDLE}/contact`),
        cancel: shownLeave.includes('action="/api/store/manage/cancel"'),
      },
      move: { prices: shownMove.includes(escaped(vw.seePrices("Studio club"))) },
      renew: {
        see: plainRenew.includes(escaped(mw.see("Studio club"))),
        prices: goneRenew.includes(escaped(mw.seePrices("Studio club"))),
        recover: plainRenew.includes(`href="/@${HANDLE}/orders"`),
      },
      orders: {
        agreements: waiting.agreements.map((a) => a.title),
        renew: endedCard.includes(`/@${HANDLE}/renew/`) || endedCard.includes(escaped(ow.renew)),
        renewInvite: endedCard.includes(escaped(ow.endedNote)),
        review: courseCard.includes(`/@${HANDLE}/review?`),
        course: courseCard.includes(`href="/@${HANDLE}/course/${courseId}"`),
      },
    };
  };

  part("The store on (control)");
  const on = await look();
  is("the community's door lists the products that open it, with the way in for members", on.gate, { products: true, memberSignIn: true });
  is("an event kept for a course lists it to a member without it", on.event, { products: true, gone: false, page: true });
  is("the course's door offers its free lesson, which opens to a visitor; its student is in", on.course, { freeLesson: true, previewToVisitor: "shown", buyerSignIn: true, studentFront: "shown", studentLesson: "shown" });
  is("a drip course: the student's way on leads to the free preview in the shut module, which opens; the rest of it waits; a visitor sees the preview", on.drip, { nextIsPreview: true, studentPreview: "shown", studentShut: `redirect /@${HANDLE}/course/${kilnId}`, visitorPreview: "shown" });
  is("the member's page: cancel and the card", on.manage, { cancel: true, card: true });
  is("asked why: a way to write to the store, and the way out", on.leave, { contact: true, cancel: true });
  is("the moving-in page with a gone price: a link to today's prices", on.move, { prices: true });
  is("the come-back page: See the product; with a gone price, today's prices; the way back to orders", on.renew, { see: true, prices: true, recover: true });
  is("orders: the proposal to sign, Renew with its invitation, the review button, the course", on.orders, { agreements: ["Kiln repair"], renew: true, renewInvite: true, review: true, course: true });

  part("The store switched off after a report");
  await noteTakedown(OWNER, null, true);
  const off = await look();
  is("the community's door: no product to buy, the way in for members kept", off.gate, { products: false, memberSignIn: true });
  is("the event: no product to buy, said as no longer offered, the event still there", off.event, { products: false, gone: true, page: true });
  is("the course's door: no free lesson offered; the way in for buyers kept", [off.course.freeLesson, off.course.buyerSignIn], [false, true]);
  is("the free lesson is not opened to a visitor", off.course.previewToVisitor, `redirect /@${HANDLE}/course/${courseId}`);
  is("the student keeps the course and its lessons", [off.course.studentFront, off.course.studentLesson], ["shown", "shown"]);
  is("a drip course: the student still reads the free preview the way on leads to; the rest still waits", [off.drip.nextIsPreview, off.drip.studentPreview, off.drip.studentShut], [true, "shown", `redirect /@${HANDLE}/course/${kilnId}`]);
  is("a drip course: a visitor, who is not a student, gets no preview", off.drip.visitorPreview, `redirect /@${HANDLE}/course/${kilnId}`);
  is("the member's page keeps cancel and the card", off.manage, { cancel: true, card: true });
  is("asked why: no way to write to the store; the way out kept", off.leave, { contact: false, cancel: true });
  is("the moving-in page: no link to prices", off.move, { prices: false });
  is("the come-back page: no link to the product or its prices; the way back to orders kept", off.renew, { see: false, prices: false, recover: true });
  is("orders: no proposal to sign, no Renew nor its invitation, no review button; the course kept", off.orders, { agreements: [], renew: false, renewInvite: false, review: false, course: true });

  part("Switched back on: all of it again");
  await noteTakedown(OWNER, null, false);
  const again = await look();
  is("the same as before it was switched off", again, on);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
