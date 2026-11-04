/**
 * The public deletion form (/privacy/delete, lib/erasure-request.ts) takes its
 * link from the access emails a visitor's typed address may use (`asked`,
 * askedCeiling), the same share the sign-up box and the waitlist use, which a
 * stranger can spend (506 [SG1], MM-SA-16). A person asking to be deleted is
 * not left without an answer when that share is spent (GDPR art. 12(2), 12(3)):
 *
 *   (a) asked for every store, when the first store that knows the address has
 *       no room, the next one that does sends the same link;
 *   (b) asked for every store, when none has room, nothing is sent and the
 *       answer is "sent", exactly the one an address no store knows gets (the
 *       full matrix is tests/erasure-request-scope-all.test.ts); the page it
 *       opens gives the privacy contact the Privacy Policy publishes;
 *   (c) asked from one store that has no room, the page says honestly that the
 *       link cannot be emailed now, from which whole day (UTC) it can be asked
 *       for again, and the same contact; never "try again in a moment". The
 *       answer is the same whether or not that store knows the address.
 *
 * Checked here: those three, that the day shown is never one the store is
 * still full on (a window ending at 23:30 UTC shows the next day), and that a
 * buyer's own course link from a full store is still sent while the deletion
 * links took no more than the visitors' share of either store.
 */
import { readFileSync } from "node:fs";
import { isValidElement, type ReactNode } from "react";
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { nextWholeDay, requestErasureLink } from "@/lib/erasure-request";
import { rememberBuyers, storesKnownFor } from "@/lib/buyer-library";
import { takeAllowance, allowanceUsed } from "@/lib/store-allowance";
import { allowanceFor, askedCeiling } from "@/lib/store-allowance-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { sendCourseLink } from "@/lib/learn";
import type { Listing } from "@/lib/catalog";
import { POST as eraseRoute } from "@/app/api/privacy/erase/route";
import DeletePage from "@/app/privacy/delete/page";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

/**
 * The email goes after the answer (lib/erasure-request.ts, afterAnswer), unwaited outside a request: wait for what
 * it does, not for a number of turns of the event loop, which a busy machine outruns (inbox C4-40). At most 2 s.
 */
const until = async (ready: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400 && !(await ready()); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};
import { done, is, part } from "./check";

const sent: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to?: unknown; text?: string };
    sent.push({ to: String(body.to), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

async function paidStore(handle: string, period: { start: number; end: number; renews: boolean } = paidPeriod()): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_1${handle.replace(/[^a-z]/g, "").padEnd(14, "x").slice(0, 14)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/[^a-z0-9]/g, "")}`, subscriptionId: `sub_${handle.replace(/[^a-z0-9]/g, "")}`, active: true, tier: "creator", period });
  return (await storeForEmail(owner))!;
}

/** Spends a store's whole share for visitors' addresses, as a stranger filling its sign-up box would. */
async function fill(store: Store): Promise<void> {
  const share = askedCeiling(allowanceFor(store, "transactional")) - (await allowanceUsed(store, "transactional"));
  if (share > 0 && !(await takeAllowance(store, "transactional", share, Date.now(), true)).ok) throw new Error("could not fill");
}

/** The text and the links of the page's chosen branch, without running its client parts. */
function walk(node: ReactNode, out = { text: "", hrefs: [] as string[] }): typeof out {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (typeof node === "string" || typeof node === "number") {
    out.text += String(node);
    return out;
  }
  if (!isValidElement<{ children?: ReactNode; href?: unknown }>(node)) return out;
  if (typeof node.props.href === "string") out.hrefs.push(node.props.href);
  walk(node.props.children, out);
  return out;
}

const ask = (fields: Record<string, string>) =>
  eraseRoute(new NextRequest("https://marktmorgen.com/api/privacy/erase", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}` }, body: new URLSearchParams({ action: "ask", ...fields }) }));

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_erasure_full_only_a_stand_in";
  const one = await paidStore("erase-full-one");
  const two = await paidStore("erase-full-two");
  const TESS = "tess@example.com";
  await rememberBuyers(one.sid, [TESS]);
  await rememberBuyers(two.sid, [TESS]);
  const known = await storesKnownFor(TESS);
  is("the address is known to both stores", known.length, 2);
  const [first, second] = await Promise.all(known.map(async (sid) => (sid === one.sid ? one : two)));

  part("(a) The first store has no room: the next one sends the link");
  await fill(first);
  const usedBefore = [await allowanceUsed(first, "transactional"), await allowanceUsed(second, "transactional")];
  const from = sent.length;
  is("the link is sent", await requestErasureLink({ email: TESS, ip: "203.0.113.20", origin: "https://marktmorgen.com" }), "sent");
  // The link sent and its share taken: the two things checked below, waited for, never assumed.
  await until(async () => sent.slice(from).some((m) => m.to === TESS) && (await allowanceUsed(second, "transactional")) > usedBefore[1]);
  const link = sent.slice(from).find((m) => m.to === TESS);
  is("to the address, naming both stores", [Boolean(link), link?.text.includes(one.name), link?.text.includes(two.name)], [true, true, true]);
  is("taken from the second store's share, nothing more from the first", [await allowanceUsed(first, "transactional"), await allowanceUsed(second, "transactional")], [usedBefore[0], usedBefore[1] + 1]);

  part("(b) Asked for every store, no store has room: the same answer as an unknown address");
  await fill(second);
  const before = sent.length;
  // The work after the answer ends, for the known address, in its log line that no store had room: waited for, so
  // "nothing is sent" is read once it could no longer send (inbox C4-40).
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...words: unknown[]) => void warned.push(words.map(String).join(" "));
  const whereAll = new URL((await ask({ email: TESS, scope: "all" })).headers.get("location") ?? "https://x.invalid/");
  const whereNobody = new URL((await ask({ email: "nobody@example.com", scope: "all" })).headers.get("location") ?? "https://x.invalid/");
  await until(() => warned.some((w) => w.includes("a deletion link asked for every store was not emailed: full")));
  console.warn = warn;
  is("the work after the answer finished, finding no room", warned.some((w) => w.includes("was not emailed: full")), true);
  is("nothing is sent", sent.length, before);
  is("the known address is told what an unknown one is: 'sent', no day", [whereAll.search, whereAll.searchParams.get("status")], [whereNobody.search, "sent"]);
  const sentPage = walk(await DeletePage({ searchParams: Promise.resolve({ status: "sent" }) }));
  is("and that page gives the privacy contact", [sentPage.hrefs.includes("mailto:support@marktmorgen.com"), sentPage.text.includes("support@marktmorgen.com")], [true, true]);

  part("(c) Asked from one store that has no room: the page says so honestly, the same for every address");
  const answer = await ask({ email: TESS, scope: "store", store: first.handle });
  const where = new URL(answer.headers.get("location") ?? "https://x.invalid/");
  const opens = where.searchParams.get("opens") ?? "";
  is("nothing is sent", sent.length, before);
  is("the answer is that it is full, not an error", where.searchParams.get("status"), "full");
  is("with the first whole day the store's window has ended by", opens, new Date(nextWholeDay(allowanceWindow(first)!.end)).toISOString().slice(0, 10));
  const page = walk(await DeletePage({ searchParams: Promise.resolve({ status: "full", opens }) }));
  const day = new Date(`${opens}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  is("the page says it cannot be emailed now", page.text.includes("can't be emailed right now"), true);
  is("and when", page.text.includes(day), true);
  is("and does not say to try again in a moment", page.text.includes("in a moment"), false);
  const policy = readFileSync("app/privacy/page.tsx", "utf8");
  is("the contact it gives is the one the Privacy Policy publishes", [page.hrefs.includes("mailto:support@marktmorgen.com"), policy.includes('href="mailto:support@marktmorgen.com"'), page.text.includes("support@marktmorgen.com")], [true, true, true]);
  const noDay = walk(await DeletePage({ searchParams: Promise.resolve({ status: "full", opens: "not-a-day" }) }));
  is("a day that cannot be read is left out, the rest is said", [noDay.text.includes("can't be emailed right now"), noDay.text.includes("not-a-day"), noDay.hrefs.includes("mailto:support@marktmorgen.com")], [true, false, true]);
  const strangerAnswer = new URL((await ask({ email: "nobody@example.com", scope: "store", store: first.handle })).headers.get("location") ?? "https://x.invalid/");
  is("an address the store does not know gets exactly the same answer", strangerAnswer.search, where.search);

  part("The day shown is never one the store is still full on");
  // A billing month that ends at 23:30 UTC ten days from now.
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const ends = today + 10 * 86_400_000 + 23.5 * 3_600_000;
  const late = await paidStore("erase-full-late", { start: Math.floor((ends - 30 * 86_400_000) / 1000), end: ends / 1000, renews: true });
  is("its window ends at 23:30 UTC", allowanceWindow(late)?.end, ends);
  await fill(late);
  const lateWhere = new URL((await ask({ email: "late@example.com", scope: "store", store: late.handle })).headers.get("location") ?? "https://x.invalid/");
  const dayAfter = new Date(today + 11 * 86_400_000).toISOString().slice(0, 10);
  is("it is shown as the day after it ends, the first whole day it is open", [lateWhere.searchParams.get("status"), lateWhere.searchParams.get("opens"), new Date(ends).toISOString().slice(0, 10) < dayAfter], ["full", dayAfter, true]);
  is("a window ending at 00:00 UTC keeps its own day", [nextWholeDay(Date.parse("2099-01-02T00:00:00Z")), nextWholeDay(Date.parse("2099-01-01T00:00:00.001Z"))], [Date.parse("2099-01-02T00:00:00Z"), Date.parse("2099-01-02T00:00:00Z")]);

  part("Buyers keep their reserved half");
  const course = { id: "c0urse0000", title: "Course" } as unknown as Listing;
  is("a buyer's course link from a full store is still sent", [await sendCourseLink(first, course, "buyer@example.com", "https://marktmorgen.com"), sent.some((s) => s.to.includes("buyer@example.com"))], [true, true]);
  is(
    "and the deletion links never went past a visitor's share of either store",
    [await allowanceUsed(first, "transactional") - 1 <= askedCeiling(allowanceFor(first, "transactional")), await allowanceUsed(second, "transactional") <= askedCeiling(allowanceFor(second, "transactional"))],
    [true, true],
  );

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
