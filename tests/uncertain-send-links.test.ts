/**
 * Access links by email whose send answer is not known (VR 2, rule 30;
 * a sibling of claude5/email-outcome-siblings' sendEmailOutcome).
 *
 * A timeout, a server error (5xx) or a network error after the request may
 * have reached the sender can mean the email went. The buyer was told "The
 * email could not be sent", which may be false; asking again then sends a
 * second link. Now such a send says so plainly ("We could not confirm the
 * email was sent. It may still arrive; check your inbox before asking
 * again."), and the link already written stays valid. A certain refusal
 * (a 4xx) keeps today's "could not be sent" answer. Checked, for the
 * buyer's library (lib/buyer-library.ts, /library), the affiliate page
 * (lib/affiliate-hub.ts, /affiliate) and a course's emailed link
 * (lib/learn.ts, the course page in the store's seven languages):
 *
 *   - a 500 and a thrown request answer "unsure", the link stays open;
 *   - a 422 answers "error" (control: unchanged);
 *   - a plain yes answers "sent" (control);
 *   - each page shows the true sentence for "unsure", and the course page
 *     has it in every buyer language, apart from its "error" notice.
 *
 * The sender is played by a stand-in for `fetch`; no real email is sent.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { libraryOwner, rememberBuyers, requestLibraryLink } from "@/lib/buyer-library";
import { hubOwner, rememberAffiliate, requestHubLink } from "@/lib/affiliate-hub";
import * as learnLinks from "@/lib/learn";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { grantImported } from "@/lib/imported-purchases";
import { readProduct } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setPastBuyers, setProductCourse, storeForEmail } from "@/lib/store";
import LibraryPage from "@/app/library/page";
import AffiliateHubPage from "@/app/affiliate/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const TRUE_TEXT = "We could not confirm the email was sent. It may still arrive; check your inbox before asking again.";

/** Every recipient the sender was asked for, taken or not. */
const asked: string[] = [];
/** The text of the last email asked for, by recipient, taken or not. */
const texts = new Map<string, string>();
/** How the sender answers one recipient, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    const to = [body.to].flat()[0] ?? "";
    asked.push(to);
    texts.set(to, body.text);
    const special = senderAnswers.get(to);
    if (special) return special();
    return new Response(JSON.stringify({ id: `email_${asked.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const SERVER_ERROR = () => new Response("{}", { status: 500 });
const THROWN = (): Response => {
  throw new TypeError("fetch failed");
};
const REFUSED = () => new Response(JSON.stringify({ message: "invalid" }), { status: 422 });
const keysOf = (prefix: string) => redis.keys().filter((k) => k.startsWith(prefix) && !k.endsWith(":opens"));
/** The token in the link emailed to this address. */
const tokenSent = (email: string) => /token=([0-9a-f]{64})/.exec(texts.get(email) ?? "")?.[1] ?? "";

async function render(page: (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>, status: string): Promise<string> {
  return renderToStaticMarkup(createElement("div", null, (await page({ searchParams: Promise.resolve({ status }) })) as never));
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  for (const k of ["AWS_SES_ROLE_ARN", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN", "STRIPE_SECRET_KEY"]) delete process.env[k];
  const OWNER = "owner@example.com";
  if (!(await claimHandle(OWNER, "harbor", "Harbor Kitchen", "")).ok) throw new Error("no store");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await setPastBuyers(OWNER);
  const made = await addProduct(OWNER, "Knife skills", "A course", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductCourse(OWNER, made.product.id, { id: "c".repeat(32), lessons: 1 });
  const harbor = (await storeForEmail(OWNER))!;
  const course = (await readProduct(harbor, made.product.id))!;
  const paidStore = { ...harbor, subscriptionActive: true, subscriptionId: null, trialEnds: 0, planEndedAt: "", tier: "pro" as const };

  part("The buyer's library");
  const lib = { unsure: "lib-500@example.com", thrown: "lib-throw@example.com", refused: "lib-422@example.com", yes: "lib-yes@example.com" };
  await rememberBuyers(harbor.sid, Object.values(lib));
  senderAnswers.set(lib.unsure, SERVER_ERROR);
  senderAnswers.set(lib.thrown, THROWN);
  senderAnswers.set(lib.refused, REFUSED);
  const libraryAnswers: Record<string, string> = {};
  for (const [name, email] of Object.entries(lib)) libraryAnswers[name] = await requestLibraryLink({ email, ip: `198.51.100.${name.length}`, origin: "https://marktmorgen.com" });
  is("a 500 and a thrown request are not said as a failure; a 422 is; a yes is sent", libraryAnswers, { unsure: "unsure", thrown: "unsure", refused: "error", yes: "sent" });
  is("the link of an unsure send still opens the library (it may have arrived)", [await libraryOwner(tokenSent(lib.unsure)), await libraryOwner(tokenSent(lib.thrown))], [lib.unsure, lib.thrown]);
  is("each address was asked once", [lib.unsure, lib.thrown, lib.refused, lib.yes].map((e) => asked.filter((to) => to === e).length), [1, 1, 1, 1]);
  const libraryUnsure = await render(LibraryPage as never, "unsure");
  const libraryError = await render(LibraryPage as never, "error");
  is("the library page says the true sentence for an unsure send", libraryUnsure.includes(TRUE_TEXT), true);
  is("and keeps 'could not be sent' for a certain refusal (control)", libraryError.includes("The email could not be sent just now."), true);

  part("The affiliate page");
  const hub = { unsure: "hub-500@example.com", thrown: "hub-throw@example.com", refused: "hub-422@example.com", yes: "hub-yes@example.com" };
  // As joining a program notes it (lib/affiliate-hub.ts rememberAffiliate).
  for (const email of Object.values(hub)) await rememberAffiliate(harbor.sid, email);
  senderAnswers.set(hub.unsure, SERVER_ERROR);
  senderAnswers.set(hub.thrown, THROWN);
  senderAnswers.set(hub.refused, REFUSED);
  const hubAnswers: Record<string, string> = {};
  for (const [name, email] of Object.entries(hub)) hubAnswers[name] = await requestHubLink({ email, ip: `198.51.100.${10 + name.length}`, origin: "https://marktmorgen.com" });
  is("a 500 and a thrown request are not said as a failure; a 422 is; a yes is sent", hubAnswers, { unsure: "unsure", thrown: "unsure", refused: "error", yes: "sent" });
  is("the link of an unsure send still opens the page", [await hubOwner(tokenSent(hub.unsure)), await hubOwner(tokenSent(hub.thrown))], [hub.unsure, hub.thrown]);
  const hubUnsure = await render(AffiliateHubPage as never, "unsure");
  const hubError = await render(AffiliateHubPage as never, "error");
  is("the affiliate page says the true sentence for an unsure send", hubUnsure.includes(TRUE_TEXT), true);
  is("and keeps 'could not be sent' for a certain refusal (control)", hubError.includes("The email could not be sent just now."), true);

  part("A course's emailed link");
  const learn = { unsure: "course-500@example.com", thrown: "course-throw@example.com", refused: "course-422@example.com", yes: "course-yes@example.com" };
  for (const [i, email] of Object.values(learn).entries()) await grantImported(harbor.statsId!, String(i).repeat(24), [{ email, productId: course.id, items: null }], 1793293200, harbor.sid);
  senderAnswers.set(learn.unsure, SERVER_ERROR);
  senderAnswers.set(learn.thrown, THROWN);
  senderAnswers.set(learn.refused, REFUSED);
  const courseAnswers: Record<string, string> = {};
  for (const [name, email] of Object.entries(learn)) courseAnswers[name] = await learnLinks.requestCourseLink({ store: paidStore, product: course, email, ip: `198.51.100.${20 + name.length}`, origin: "https://marktmorgen.com" });
  is("a 500 and a thrown request are not said as a failure; a 422 is; a yes is sent", courseAnswers, { unsure: "unsure", thrown: "unsure", refused: "error", yes: "sent" });
  is("the links of the unsure sends stay written (4 asked, 4 links kept)", keysOf("nl:learn:link:").length, 4);
  senderAnswers.set("course-again@example.com", SERVER_ERROR);
  // Through the namespace, so this file builds before the function exists (RED).
  const outcome = (learnLinks as unknown as { sendCourseLinkOutcome?: typeof learnLinks.sendCourseLink }).sendCourseLinkOutcome;
  const after = async (email: string) => (outcome ? await outcome(paidStore, course, email, "https://marktmorgen.com") : "missing");
  is("the send after paying in another browser tells the same apart", [await after("course-again@example.com"), await after(learn.refused), await after(learn.yes)], ["uncertain", "refused", "sent"]);
  const english = coursesWords("en").linkNotices.unsure as { title: string; body: string } | undefined;
  is("the course page's English notice is the true sentence", english ? `${english.title}. ${english.body}` : null, TRUE_TEXT);
  for (const code of LANGUAGE_CODES) {
    const w = coursesWords(code).linkNotices;
    const unsure = w.unsure;
    is(`${code}: an unsure notice, apart from the error notice`, [Boolean(unsure?.title && unsure?.body), unsure?.title !== w.error?.title, unsure?.body !== w.error?.body], [true, true, true]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
