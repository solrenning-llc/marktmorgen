/**
 * A store's whole export says what it could not read, by name and truly
 * (CX-123 rule 24; VR item 2), audit of 9 November 2026 (exports):
 *
 *  1. The course outlines were read with readCourses, which takes an MGET in
 *     an unknown shape, or an outline kept but unreadable, for "no course":
 *     the file said "courses":[] with no note and ended with "Nothing else is
 *     in this file", and exportShape priced the export at fewer lessons. A
 *     store whose plan has ended has ENDED_STORE_EXPORTS (1) of this file.
 *     Now the outlines are read exactly (readCoursesExact): the measuring
 *     refuses, and the file writes the products, leaves the courses out and
 *     says so (coursesNote), and never ends with "Nothing else". The lessons'
 *     text that cannot be read is said the same way (lessonTextNote), with
 *     the outlines kept. To a store whose plan has ended, every such note
 *     says the part is not in this file, never to download again in a few
 *     minutes (the route refuses that download).
 *  2. The orders' note blamed Stripe ("the rest are on your own Stripe
 *     account") for PayPal sales that could not be read, even for a store
 *     with no Stripe account, and for orders whose currency Stripe did not
 *     name (those are in the file). It now names what happened.
 *  3. A contact kept but unreadable was left out of the list's file, the
 *     export's contacts and an API page without a word. They are counted and
 *     said: the export's contactsNote, the download's "-partial" file name,
 *     the API page's `unreadable`.
 *
 * Synthetic stores, the in-memory database and a stubbed Stripe only.
 */
import { NextRequest } from "next/server";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { GET as leadsRoute } from "@/app/api/store/leads/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readListing } from "@/lib/catalog";
import { readCourse } from "@/lib/course";
import { exportShape, storeExport } from "@/lib/store-export";
import { leads } from "@/lib/api-read";
import { leadsKey } from "@/lib/contacts";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setPayPalSeller, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Store } from "@/lib/store";
import { standingOf } from "@/lib/plan-standing";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Cmd = (string | number)[];

const real: Pipeline = redis.pipeline.bind(redis);
/** Every command `match` picks answers `reply(what it really answered)`, or throws when `reply` is "throw". */
function swap(match: (c: Cmd) => boolean, reply: ((out: unknown) => unknown) | "throw"): void {
  (redis as unknown as { pipeline: Pipeline }).pipeline = (async (commands: Cmd[]) => {
    if (reply === "throw" && commands.some(match)) throw new Error("the database did not answer (synthetic)");
    const out = await real(commands);
    return commands.map((c, i) => (match(c) && reply !== "throw" ? reply(out[i]) : out[i]));
  }) as Pipeline;
}
const restore = () => ((redis as unknown as { pipeline: Pipeline }).pipeline = real);

async function textOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}
const parse = (text: string): Record<string, unknown> => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { notJson: text.slice(0, 200) };
  }
};

const RUNNING_LATER = "could not be read just now. Download the file again in a few minutes.";
const ENDED_WORDS = "could not be read just now, so they are not in this file. A store whose plan has ended downloads this file once, and starting a plan again lets you download it again.";
const NOTHING_ELSE = "Nothing else is in this file.";

let n = 0;
/** A store with one course of one lesson with text; ended when asked (made while it ran, then its plan ended). */
async function courseStore(ended: boolean): Promise<{ owner: string; store: () => Promise<Store>; courseId: string }> {
  n += 1;
  const owner = `export-exact-${n}@example.com`;
  await claimHandle(owner, `exportexact${n}`, "Export Exact", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: `cus_exportexact${n}`, subscriptionId: `sub_exportexact${n}`, active: true, tier: "creator", period: paidPeriod() });
  const sid = (await storeForEmail(owner))!.sid!;
  const headers = { "content-type": "application/json", "x-nimbus-store": sid, cookie: `${SESSION_COOKIE}=${await openSession(owner)}` };
  const made = await addProduct(owner, "My course", "", "40");
  if (!made.ok) throw new Error("product not made");
  const enabled = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers, body: JSON.stringify({ action: "enable", id: made.product.id }) }));
  if (!((await enabled.json()) as { ok?: boolean }).ok) throw new Error("course not enabled");
  const courseId = (await readListing((await storeForEmail(owner))!, made.product.id))!.course!.id;
  const course = (await readCourse(courseId))!;
  course.modules[0].lessons.push({ id: "lesson000001", title: "Lesson one", preview: false, video: null, files: [], link: null, hasBody: true, quiz: null });
  await real([["SET", `nl:course:${courseId}`, JSON.stringify(course)], ["SET", `nl:course:${courseId}:body:lesson000001`, "The first lesson's words."]]);
  if (ended) await setSubscription(owner, { customerId: `cus_exportexact${n}`, subscriptionId: `sub_exportexact${n}`, active: false });
  return { owner, store: async () => (await storeForEmail(owner))!, courseId };
}

const outlineRead = (c: Cmd) => c[0] === "MGET" && String(c[1]).startsWith("nl:course:") && !String(c[1]).includes(":body:");
const bodyRead = (c: Cmd) => c[0] === "MGET" && String(c[1]).includes(":body:");
const OUTLINE_CASES: [string, ((out: unknown) => unknown) | "throw"][] = [
  ["the MGET answered without a list", () => undefined],
  ["the MGET answered 'OK'", () => "OK"],
  ["the MGET answered a shorter list", () => []],
  ["the outline is kept but unreadable", (out) => (out as unknown[]).map(() => "{not json")],
  ["the MGET threw", "throw"],
];

process.env.STRIPE_SECRET_KEY = "sk_test_export_exact_stand_in";
/** What Stripe answers for the checkouts list: "pages" always has more (a new row a page), "nocurrency" one paid sale with no currency. */
let stripeMode: "pages" | "nocurrency" | "empty" = "empty";
let stripePage = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[], more = false) => new Response(JSON.stringify({ data, has_more: more }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) {
    if (stripeMode === "pages") {
      stripePage += 1;
      return list([{ id: `cs_test_page${String(stripePage).padStart(4, "0")}`, status: "open", payment_status: "unpaid", metadata: {} }], true);
    }
    if (stripeMode === "nocurrency") {
      return list([{ id: "cs_test_nocurrency1", status: "complete", payment_status: "paid", amount_total: 2500, created: 1_790_000_000, metadata: { store: `stripeexact`, product: "p1" }, customer_details: { email: "buyer@example.com" } }]);
    }
  }
  return list([]);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("1. Control: a store whose courses read");
  const a = await courseStore(false);
  const healthy = await textOf(storeExport(await a.store()));
  const h = parse(healthy);
  is(
    "the course and its lesson's text are in the file, with no note, and it ends with what is not in it",
    [(h.courses as unknown[] | undefined)?.length, JSON.stringify(h.courses ?? "").includes("The first lesson's words."), "coursesNote" in h, "lessonTextNote" in h, healthy.includes(NOTHING_ELSE)],
    [1, true, false, false, true],
  );
  const shape = await exportShape(await a.store());
  is("the measuring counts the course", shape.commands > 0, true);

  part("1. The course outlines answered in an unknown shape (a store whose plan runs)");
  for (const [name, reply] of OUTLINE_CASES) {
    swap(outlineRead, reply);
    try {
      const text = await textOf(storeExport(await a.store()));
      const got = parse(text);
      is(
        `${name}: the products are still in the file, the courses are left out and said, never "courses":[] nor "Nothing else"`,
        [(got.products as unknown[] | undefined)?.length, "courses" in got, got.coursesNote, text.includes(NOTHING_ELSE)],
        [1, false, `The courses and their lessons' text ${RUNNING_LATER}`, false],
      );
      const measured = await exportShape(await a.store()).then(
        () => "priced",
        () => "refused",
      );
      is(`${name}: the measuring refuses, never prices the export without the course`, measured, "refused");
    } finally {
      restore();
    }
  }

  part("1. The lessons' text could not be read: the outlines stay, the text is said");
  swap(bodyRead, "throw");
  try {
    const text = await textOf(storeExport(await a.store()));
    const got = parse(text);
    is(
      "the products and the course's outline are in the file, the text is said, never \"Nothing else\"",
      [(got.products as unknown[] | undefined)?.length, (got.courses as unknown[] | undefined)?.length, got.lessonTextNote, text.includes(NOTHING_ELSE)],
      [1, 1, `The lessons' text ${RUNNING_LATER}`, false],
    );
  } finally {
    restore();
  }

  part("1. A store whose plan has ended: its one file never promises a download again in a few minutes");
  const e = await courseStore(true);
  is("the store's plan has ended", standingOf(await e.store()), "ended");
  swap(outlineRead, () => "OK");
  try {
    const text = await textOf(storeExport(await e.store()));
    const got = parse(text);
    is("the courses are said not to be in this file", [got.coursesNote, "courses" in got, text.includes(NOTHING_ELSE), text.includes("in a few minutes")], [`The courses and their lessons' text ${ENDED_WORDS}`, false, false, false]);
  } finally {
    restore();
  }
  // The sibling notes of the same part (rule 30): a product's page that could not be read.
  swap((c) => String(c[1] ?? "").startsWith("nl:product:page:"), "throw");
  try {
    const text = await textOf(storeExport(await e.store()));
    const got = parse(text);
    const notes = Object.entries(got).filter(([k]) => /Note$/.test(k) && k !== "ordersNote").map(([, v]) => String(v));
    is("every note an ended store's file carries says the part is not in this file", [notes.length > 0, notes.every((v) => v.endsWith(ENDED_WORDS)), text.includes("in a few minutes")], [true, true, false]);
  } finally {
    restore();
  }

  part("2. PayPal sales that could not be read are never said to be on the store's Stripe account");
  n += 1;
  const paypalOwner = `export-exact-${n}@example.com`;
  await claimHandle(paypalOwner, `exportexact${n}`, "Export Exact PayPal", "");
  await ensureStatsId(paypalOwner);
  await ensureStoreId(paypalOwner);
  await setSubscription(paypalOwner, { customerId: `cus_exportexact${n}`, subscriptionId: `sub_exportexact${n}`, active: true, tier: "creator", period: paidPeriod() });
  await setPayPalSeller(paypalOwner, "EXPORTEXACT01");
  const paypalStore = (await storeForEmail(paypalOwner))!;
  is("control: the store sells through PayPal only", [paypalStore.stripeAccountId, Boolean(paypalStore.paypalSeller)], [null, true]);
  swap((c) => c[0] === "ZREVRANGEBYSCORE" && String(c[1]).startsWith("nl:ppsell:sales:"), "throw");
  try {
    const got = parse(await textOf(storeExport(paypalStore)));
    const note = String(got.ordersNote ?? "");
    is("the note names PayPal, never Stripe", [/PayPal/.test(note), /Stripe/.test(note)], [true, false]);
  } finally {
    restore();
  }

  part("2. Stripe sales: more than one file reads, and a sale whose currency Stripe did not name");
  const stripeOwner = "export-exact-stripe@example.com";
  await claimHandle(stripeOwner, "stripeexact", "Stripe Exact", "");
  await ensureStatsId(stripeOwner);
  await ensureStoreId(stripeOwner);
  await setSubscription(stripeOwner, { customerId: "cus_exportexacts", subscriptionId: "sub_exportexacts", active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(stripeOwner, "acct_TestExportExact1", true);
  const stripeStore = (await storeForEmail(stripeOwner))!;
  stripeMode = "pages";
  stripePage = 0;
  const paged = parse(await textOf(storeExport(stripeStore)));
  is("past the pages one file reads, the note says the rest are on the store's Stripe account", paged.ordersNote, "More orders than one file reads: the rest are on your own Stripe account.");
  stripeMode = "nocurrency";
  const nocurrency = parse(await textOf(storeExport(stripeStore)));
  const note = String(nocurrency.ordersNote ?? "");
  is(
    "a sale without a currency is in the file, and the note says its currency is missing, never that orders are elsewhere",
    [String(nocurrency.ordersCsv ?? "").includes("cs_test_nocurrency1"), /currency/.test(note), note.includes("More orders than one file reads")],
    [true, true, false],
  );
  stripeMode = "empty";

  part("3. A contact kept but unreadable is counted and said, never left out without a word");
  n += 1;
  const listOwner = `export-exact-${n}@example.com`;
  await claimHandle(listOwner, `exportexact${n}`, "Export Exact List", "");
  await ensureStatsId(listOwner);
  await ensureStoreId(listOwner);
  await ensureListId(listOwner);
  await setSubscription(listOwner, { customerId: `cus_exportexact${n}`, subscriptionId: `sub_exportexact${n}`, active: true, tier: "creator", period: paidPeriod() });
  const listStore = (await storeForEmail(listOwner))!;
  await real([["HSET", leadsKey(listStore.listId!), "good@example.com", JSON.stringify({ agreed: true }), "kept@example.com", "{corrupt"]]);
  const exported = parse(await textOf(storeExport(listStore)));
  is(
    "the export keeps the readable contacts and says one could not be read",
    [String(exported.contactsCsv ?? "").includes("good@example.com"), exported.contactsNote],
    [true, "1 contact on your list could not be read, so it is not in this file."],
  );
  const downloaded = await leadsRoute(new NextRequest("https://marktmorgen.com/api/store/leads", { headers: { "x-nimbus-store": listStore.sid!, cookie: `${SESSION_COOKIE}=${await openSession(listOwner)}` } }));
  const body = await downloaded.text();
  is(
    "the list's download keeps the readable contacts, and its file name says it is not the whole list",
    [downloaded.status, body.includes("good@example.com"), /-partial\.csv"$/.test(downloaded.headers.get("content-disposition") ?? "")],
    [200, true, true],
  );
  const page = (await leads(listStore, null, false)) as { data: { email?: unknown }[]; unreadable?: number };
  is("the API page keeps the readable contact and says how many it could not read", [page.data.map((r) => r.email), page.unreadable], [["good@example.com"], 1]);
  await real([["HDEL", leadsKey(listStore.listId!), "kept@example.com"]]);
  const whole = (await leads(listStore, null, false)) as { unreadable?: number };
  is("control: a whole page carries no count", "unreadable" in whole, false);

  done();
}

void main();
