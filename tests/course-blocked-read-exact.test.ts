/**
 * A student the creator took off a course stays off it, also when Redis answers
 * the "taken off?" read in a shape that is not its own (CX-123 rule 24, audit SG2).
 *
 * lib/learn.ts reads the course's blocked set in two places that decide what a
 * removed student gets:
 *
 *   - courseLedger (paidCourses, courseAccess): SISMEMBER per paid course. Only
 *     an exact 0 keeps the course open; an exact 1 shuts it; anything else (null,
 *     a reply missing from the pipeline, a string, 2) is unknown and the read
 *     fails as unknown (UnknownReplyError), so the page says it did not load
 *     (app/error.tsx) instead of opening the course or telling a buyer they have
 *     no access;
 *   - sendDripEmails (through studentsOf): SMEMBERS of the blocked set. An
 *     unknown list never counts as "nobody blocked": the course's emails wait for
 *     a pass that reads it, and no "a module opened" email goes to a removed
 *     student.
 *
 * And the studio's Students table (app/studio/course/[product]/page.tsx), from
 * the same studentsOf: an unknown blocked list is said as unknown, in words,
 * never drawn as "not taken off" with a "Remove access" button that would act on
 * a guess; a note above the table says why the buttons are not there.
 *
 * Synthetic store, Stripe answered by a stand-in, no email leaves the test.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { paidCourses, recordEnrollment, registerDrip, sendDripEmails, setBlocked, emailKey } from "@/lib/learn";
import { UnknownReplyError } from "@/lib/redis-reply";
import { readListing } from "@/lib/catalog";
import type { Course } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import * as editor from "@/components/course-editor";
import { studentsOf } from "@/lib/learn";

process.env.STRIPE_SECRET_KEY = "sk_test_course_blocked_read_only";

const OWNER = "teacher@example.com";
const ACCOUNT = "acct_1TestBlocked001";
const NOW = Math.floor(Date.now() / 1000);
const COURSE = "c".repeat(32);

const sessions: Record<string, Record<string, unknown>[]> = {};
const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname !== "api.stripe.com") {
    sent.push(url.hostname);
    return answer({ error: "no network in this test" }, 500);
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** What the next reads of the blocked set answer instead of Redis's own reply; "missing" drops it from the pipeline. */
let blockedReply: { on: string; value: unknown } | null = null;
const commands: Command[] = [];
redis.pipeline = (async (batch: Command[]) => {
  commands.push(...batch);
  const replies = await real(batch);
  if (!blockedReply) return replies;
  const at = batch.findIndex((c) => c[0] === blockedReply!.on && String(c[1]).endsWith(":blocked"));
  if (at < 0) return replies;
  if (blockedReply.value === "missing") return replies.slice(0, at).concat(replies.slice(at + 1));
  const out = [...replies];
  out[at] = blockedReply.value;
  return out;
}) as typeof redis.pipeline;

const UNKNOWN: [string, unknown][] = [
  ["null", null],
  ["missing from the pipeline", "missing"],
  ["the string \"1\"", "1"],
  ["the string \"0\"", "0"],
  ["2", 2],
  ["-1", -1],
  ["a list", [1]],
];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "school", "Night School", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Bookkeeping Basics", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductCourse(OWNER, made.product.id, { id: COURSE, lessons: 2 });
  const productId = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const paid = (id: string) => ({
    id,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: NOW - 86_400,
    customer: "cus_TestBlocked01",
    metadata: { store: "school", product: productId },
    payment_intent: { id: `pi_${id.slice(8)}`, latest_charge: { object: "charge", amount: 4900, amount_refunded: 0, refunded: false } },
  });
  const outcome = async (email: string): Promise<string[] | string> => {
    try {
      return [...(await paidCourses(store, email)).keys()];
    } catch (error) {
      return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
    }
  };

  part("Course access: the controls, with Redis's own answers");
  sessions["ana@example.com"] = [paid("cs_test_ana000000001")];
  await recordEnrollment(store, "ana@example.com", productId, NOW - 86_400);
  is("a buyer not taken off: open", await outcome("ana@example.com"), [productId]);
  await setBlocked(store, COURSE, "ana@example.com", true);
  is("taken off by the creator: shut", await outcome("ana@example.com"), []);

  part("Course access: a removed student, the blocked read answered in another shape");
  for (const [name, value] of UNKNOWN) {
    blockedReply = { on: "SISMEMBER", value };
    // The cached Stripe answer is the same either way; the blocked set is read on every visit.
    is(`${name}: never opened, said as unknown`, await outcome("ana@example.com"), "unknown");
    blockedReply = null;
  }
  part("Course access: a buyer never removed, the blocked read answered in another shape");
  sessions["bo@example.com"] = [paid("cs_test_bo0000000001")];
  await recordEnrollment(store, "bo@example.com", productId, NOW - 86_400);
  for (const [name, value] of UNKNOWN) {
    blockedReply = { on: "SISMEMBER", value };
    // Not "closed" (which reads as "you have no access"): the page says it did not load, and opens on the next try.
    is(`${name}: said as unknown, not as shut`, await outcome("bo@example.com"), "unknown");
    blockedReply = null;
  }
  is("bo, read again with Redis's own answer: open", await outcome("bo@example.com"), [productId]);

  part("Module emails: a removed student is never told a module opened");
  const course = {
    id: COURSE,
    modules: [{ id: "m1", title: "Week two", dripDays: 7, lessons: [{ id: "l1", title: "Ledgers" }] }],
    certificate: false,
    startsAt: null,
  } as unknown as Course;
  const listing = (await readListing(store, productId))!;
  await registerDrip(store, listing, course);
  const joined = NOW - 7 * 86_400 - 3600;
  await redis.pipeline([["HSET", `nl:course:${COURSE}:students`, emailKey("ana@example.com"), JSON.stringify({ e: "ana@example.com", s: joined, l: joined })]]);
  const claimFor = (email: string) => `:dripmail:${emailKey(email)}:`;
  const claimed = (email: string) => commands.some((c) => c[0] === "SET" && String(c[1]).includes(claimFor(email)));
  const sweep = () => sendDripEmails(async (handle) => (handle === "school" ? store : null), async (id) => (id === COURSE ? course : null), "https://marktmorgen.test", NOW);

  for (const [name, value] of [...UNKNOWN.filter(([n]) => n !== "missing from the pipeline"), ["missing from the pipeline", "missing"] as [string, unknown]]) {
    commands.length = 0;
    blockedReply = { on: "SMEMBERS", value };
    let threw = "";
    await sweep().catch((error) => {
      threw = String(error);
    });
    blockedReply = null;
    is(`${name}: no module email claimed for the removed student`, claimed("ana@example.com"), false);
    is(`${name}: the sweep itself goes on`, threw, "");
  }
  commands.length = 0;
  await sweep();
  is("control: known blocked, no email claimed", claimed("ana@example.com"), false);
  await setBlocked(store, COURSE, "ana@example.com", false);
  commands.length = 0;
  await sweep();
  is("control: known not blocked, the module email is claimed", claimed("ana@example.com"), true);

  part("Studio Students table: an unknown blocked list is said as unknown");
  const access = (blocked: boolean | null): string => {
    try {
      const element = createElement(editor.StudentAccess as (p: { productId: string; email: string; blocked: boolean | null }) => ReturnType<typeof editor.StudentAccess>, { productId: "p1", email: "ana@example.com", blocked });
      return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {} } as never }, element));
    } catch (error) {
      return `threw: ${String(error)}`;
    }
  };
  const unknownCell = access(null);
  is("unknown: the cell says access is not known, in words", unknownCell.includes("Access not known"), true);
  is("unknown: no button that would act on a guess", unknownCell.includes("<button"), false);
  is("control: known removed, the button lets them back in", access(true).includes("Let back in"), true);
  is("control: known not removed, the button removes access", access(false).includes("Remove access"), true);
  const Note = (editor as Record<string, unknown>).StudentsBlockedUnknown as (() => ReturnType<typeof editor.StudentAccess>) | undefined;
  const note = Note ? renderToStaticMarkup(createElement(Note)) : "";
  is("the note says the list could not be read, that the buttons are hidden, and how to try again", [note.includes("could not check"), note.includes("buttons"), note.includes("Reload the page")], [true, true, true]);
  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  is("the page reads blockedKnown, draws the note on an unknown list, and hands the cell null", [page.includes("const { students, total, blockedKnown } = await studentsOf(course, 500);"), page.includes("{blockedKnown ? null : <StudentsBlockedUnknown />}"), page.includes("blocked={blockedKnown ? student.blocked : null}")], [true, true, true]);
  blockedReply = { on: "SMEMBERS", value: null };
  const read = await studentsOf(course, 500);
  blockedReply = null;
  is("studentsOf on an unknown list: blockedKnown false, so the page draws no guess", read.blockedKnown, false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
