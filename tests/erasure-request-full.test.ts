/**
 * The public deletion form (/privacy/delete, lib/erasure-request.ts) takes its
 * link from the access emails a visitor's typed address may use (`asked`,
 * askedCeiling), the same share the sign-up box and the waitlist use, which a
 * stranger can spend (506 [SG1], MM-SA-16). A person asking to be deleted is
 * not left without an answer when that share is spent (GDPR art. 12(2), 12(3)):
 *
 *   (a) when the first store that knows the address has no room, the next one
 *       that does sends the same link;
 *   (b) when none has room, the page says honestly that the link cannot be
 *       emailed now, when it can be asked for again, and the privacy contact
 *       the Privacy Policy publishes; never "try again in a moment".
 *
 * Buyers' own access emails keep the half that is reserved for them, and a
 * store's answer when it is full is the same whether or not it knows the
 * address, so the form still says nothing about who buys where.
 */
import { readFileSync } from "node:fs";
import { isValidElement, type ReactNode } from "react";
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { requestErasureLink } from "@/lib/erasure-request";
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

async function paidStore(handle: string): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_1${handle.replace(/[^a-z]/g, "").padEnd(14, "x").slice(0, 14)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
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
  const link = sent.slice(from).find((m) => m.to === TESS);
  is("to the address, naming both stores", [Boolean(link), link?.text.includes(one.name), link?.text.includes(two.name)], [true, true, true]);
  is("taken from the second store's share, nothing more from the first", [await allowanceUsed(first, "transactional"), await allowanceUsed(second, "transactional")], [usedBefore[0], usedBefore[1] + 1]);

  part("(b) No store has room: the page says so honestly");
  await fill(second);
  const before = sent.length;
  const answer = await ask({ email: TESS, scope: "all" });
  const where = new URL(answer.headers.get("location") ?? "https://x.invalid/");
  const opens = where.searchParams.get("opens") ?? "";
  is("nothing is sent", sent.length, before);
  is("the answer is that it is full, not an error", where.searchParams.get("status"), "full");
  const ends = Math.min(allowanceWindow(first)!.end, allowanceWindow(second)!.end);
  is("with the day it can be asked for again: the soonest store's window end", opens, new Date(ends).toISOString().slice(0, 10));
  const page = walk(await DeletePage({ searchParams: Promise.resolve({ status: "full", opens }) }));
  const day = new Date(`${opens}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  is("the page says it cannot be emailed now", page.text.includes("can't be emailed right now"), true);
  is("and when", page.text.includes(day), true);
  is("and does not say to try again in a moment", page.text.includes("in a moment"), false);
  const policy = readFileSync("app/privacy/page.tsx", "utf8");
  is("the contact it gives is the one the Privacy Policy publishes", [page.hrefs.includes("mailto:support@marktmorgen.com"), policy.includes('href="mailto:support@marktmorgen.com"'), page.text.includes("support@marktmorgen.com")], [true, true, true]);
  const noDay = walk(await DeletePage({ searchParams: Promise.resolve({ status: "full", opens: "not-a-day" }) }));
  is("a day that cannot be read is left out, the rest is said", [noDay.text.includes("can't be emailed right now"), noDay.text.includes("not-a-day"), noDay.hrefs.includes("mailto:support@marktmorgen.com")], [true, false, true]);

  part("A full store answers the same whether or not it knows the address");
  const knownAnswer = new URL((await ask({ email: TESS, scope: "store", store: first.handle })).headers.get("location") ?? "https://x.invalid/");
  const strangerAnswer = new URL((await ask({ email: "nobody@example.com", scope: "store", store: first.handle })).headers.get("location") ?? "https://x.invalid/");
  is("both are told it is full, on the same day", [knownAnswer.searchParams.get("status"), strangerAnswer.searchParams.get("status"), knownAnswer.searchParams.get("opens") === strangerAnswer.searchParams.get("opens")], ["full", "full", true]);

  part("Buyers keep their reserved half");
  const course = { id: "c0urse0000", title: "Course" } as unknown as Listing;
  is("a buyer's course link from a full store is still sent", [await sendCourseLink(first, course, "buyer@example.com", "https://marktmorgen.com"), sent.some((s) => s.to.includes("buyer@example.com"))], [true, true]);
  is("and the deletion links never went past a visitor's share", [await allowanceUsed(second, "transactional") <= askedCeiling(allowanceFor(second, "transactional"))], [true]);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
