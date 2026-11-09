/**
 * What a person reads when deleting themselves (/privacy/delete,
 * lib/erasure-request.ts) is refused or cannot be confirmed (VR item 2:
 * nothing shown to a person may say what is not true today).
 *
 *   (1) Since the owner's decision 9 (9 November 2026, claude5/rights-budget),
 *       a store whose studio allowance is spent, or whose free places are
 *       taken this month, no longer refuses a person's own deletion: it is
 *       paid from the budget for people's data rights (lib/rights-budget.ts)
 *       and done, so the page never says an allowance is used up or "press
 *       the button again in a while" for it. A store that only ran out of time
 *       on this press is still told to press again. (What a used-up rights
 *       budget does, scheduled with its date, is tests/rights-budget.test.ts.)
 *   (2) The answer to an ask is given before any email is tried (so the page
 *       never tells who buys where), so it never says a link "is on its way":
 *       it says one may not go out, and what to do then.
 *   (3) The page that says the link cannot be emailed ("full") gives the same
 *       art. 12(4) information, and no refusal page promises an answer time
 *       nothing in the code keeps.
 *   (4) The help answer about deleting says a store may not be able to do it
 *       at once, and where to write then.
 *   (5) So do the Privacy Policy's own words on deleting and the opening of
 *       the deletion page: neither promises the link is always emailed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactNode } from "react";
import { NextRequest } from "next/server";
import DeletePage from "@/app/privacy/delete/page";
import { POST } from "@/app/api/privacy/erase/route";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { calendarWindow } from "@/lib/allowance-window";
import { makeErasureReceipt, readErasureReceipt } from "@/lib/erasure-receipt";
import { HELP_SECTIONS } from "@/lib/help-content";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

type Region = { role: string; text: string };
type Seen = { text: string; hrefs: string[]; regions: Region[]; confirms: number };

/** The text, links, live regions and confirm forms of the page's chosen branch, without running its client parts. */
function walk(node: ReactNode, out: Seen = { text: "", hrefs: [], regions: [], confirms: 0 }): Seen {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (typeof node === "string" || typeof node === "number") {
    out.text += String(node);
    return out;
  }
  if (!isValidElement<{ children?: ReactNode; href?: string; role?: string; name?: string; value?: string }>(node)) return out;
  if (typeof node.props.href === "string") out.hrefs.push(node.props.href);
  if (node.type === "input" && node.props.name === "action" && node.props.value === "confirm") out.confirms += 1;
  if (typeof node.props.role === "string") {
    const inner = walk(node.props.children);
    out.regions.push({ role: node.props.role, text: inner.text }, ...inner.regions);
    out.text += inner.text;
    out.hrefs.push(...inner.hrefs);
    out.confirms += inner.confirms;
    return out;
  }
  walk(node.props.children, out);
  return out;
}

const show = async (query: Record<string, string>): Promise<Seen> => walk(await DeletePage({ searchParams: Promise.resolve(query) }));
const linkKey = (token: string) => `nl:erase:link:${createHash("sha256").update(`nimbus-erase-link:${token}`).digest("hex").slice(0, 40)}`;

async function storeFor(handle: string, paid: boolean): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  if (paid) await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

/** Presses the button on a live link for this store, as the person would, and opens the page the answer goes to. */
async function press(store: Store, token: string): Promise<{ status: string; page: Seen; kept: boolean }> {
  const email = `person-${token.slice(0, 4)}@example.com`;
  await upsertContact(store.listId!, email, { agreed: true, explicit: true, source: "free" }, ROOM);
  redis.run(["SET", linkKey(token), JSON.stringify({ e: email, s: [store.sid] }), "EX", 3600]);
  const response = await POST(
    new NextRequest("https://marktmorgen.com/api/privacy/erase", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://marktmorgen.com", host: "marktmorgen.com" },
      body: new URLSearchParams({ action: "confirm", token }),
    }),
  );
  const query = Object.fromEntries(new URL(response.headers.get("location")!).searchParams);
  return { status: query.status ?? "", page: await show(query), kept: redis.run(["GET", linkKey(token)]) !== null };
}

const SUPPORT = "mailto:support@marktmorgen.com";
const PRESS_AGAIN_SOON = /Press the button again in a while/i;
const COMPLAINT = /data protection authority/i;
const COURT = /\bcourt\b/i;
const ANSWER_TIME = /within the time the law requires/i;

/**
 * Rule 23 (claude5/rights-budget, owner's decision 9): this held the refusal a spent studio or a full free pool
 * caused ("more", "used up", "will not help until", the support address and GDPR art. 12(4) in an alert). Neither
 * refuses a person's deletion any longer, so it now holds that the deletion is done and nothing of a refusal is said.
 */
function doneNotRefused(label: string, seen: Seen): void {
  is(`${label}: told it is done`, /You were deleted from 1 store\b/.test(seen.text), true);
  is(`${label}: never told to press again in a while`, PRESS_AGAIN_SOON.test(seen.text), false);
  is(`${label}: never told an allowance is used up`, /used up/i.test(seen.text), false);
  is(`${label}: promises no answer time the code does not keep`, ANSWER_TIME.test(seen.text), false);
  is(`${label}: no alert region (nothing went wrong)`, seen.regions.some((r) => r.role === "alert"), false);
}

async function main(): Promise<void> {
  redis.clear();
  const keyBefore = process.env.NIMBUS_DATA_KEY;
  process.env.NIMBUS_DATA_KEY = "synthetic-refusal-truth-key-32-characters";
  try {
    part("(1a) The store's studio allowance is spent: the deletion is done anyway (owner's decision 9)");
    const spent = await storeFor("refusalspent", true);
    const whole = allowanceFor(spent, "studio");
    is("the store's studio allowance is taken whole first", (await takeAllowance(spent, "studio", whole)).ok, true);
    const limit = await press(spent, "a".repeat(64));
    // Rule 23: was "more" (refused, nothing deleted); the rights budget pays, so it is done.
    is("the press answers done", limit.status, "done");
    // Rule 23: was true (kept for pressing again); nothing is left to press.
    is("the link is used up", limit.kept, false);
    doneNotRefused("studio spent", limit.page);

    part("(1b) The free stores' places are taken this month: done anyway, at the company's cost");
    const free = await storeFor("refusalpool", false);
    redis.run(["SET", `nl:free:n:${calendarWindow().id}`, "1000000"]);
    const pool = await press(free, "b".repeat(64));
    // Rule 23: was "more" (refused by the free pool); a store that pays nothing is the company's rights budget.
    is("the press answers done", pool.status, "done");
    doneNotRefused("free places taken", pool.page);
    redis.run(["DEL", `nl:free:n:${calendarWindow().id}`]);

    part("(1c) A store that only has to be pressed again is still told to press again");
    const token = "c".repeat(64);
    const live = await storeFor("refusalretry", true);
    redis.run(["SET", linkKey(token), JSON.stringify({ e: "retry@example.com", s: [live.sid] }), "EX", 3600]);
    const retry = await show({ token, status: "more", receipt: makeErasureReceipt("more", 0, token) });
    is("told to press the button again", /Press the button again/i.test(retry.text), true);
    is("not told an allowance is used up", /used up/i.test(retry.text), false);
    is("the button is there", retry.confirms, 1);

    // Rule 23 (claude5/rights-budget): (1d) held the receipt's `held`/`left` (stores refused by an allowance). No store
    // refuses for an allowance now; the receipt carries how many were scheduled and their date instead (`scheduled`, `by`).
    part("(1d) The signed receipt carries how many stores were scheduled and by when, and nothing else can be made to");
    const now = Date.now();
    const by = now + 30 * 86_400_000;
    const waitingReceipt = makeErasureReceipt("more", 1, token, now, { scheduled: 2, by });
    is("a scheduled receipt reads back", readErasureReceipt(waitingReceipt, token, now), { state: "more", count: 1, scheduled: 2, by });
    is("a receipt with none scheduled is the old shape", readErasureReceipt(makeErasureReceipt("more", 1, token, now), token, now), { state: "more", count: 1 });
    is("a scheduled finished deletion reads back too", readErasureReceipt(makeErasureReceipt("done", 0, token, now, { scheduled: 1, by }), token, now), { state: "done", count: 0, scheduled: 1, by });
    is("a date before the press, or more than a month after it, is refused", [makeErasureReceipt("more", 0, token, now, { scheduled: 1, by: now - 1 }), makeErasureReceipt("more", 0, token, now, { scheduled: 1, by: now + 40 * 86_400_000 })], ["", ""]);
    is("a negative or fractional count is refused", [makeErasureReceipt("more", 0, token, now, { scheduled: -1, by }), makeErasureReceipt("more", 0, token, now, { scheduled: 0.5, by })], ["", ""]);
    const mixed = await show({ token, status: "more", receipt: makeErasureReceipt("more", 0, token, now, { scheduled: 1, by }) });
    is("one scheduled and one left: says the one is scheduled", /scheduled/.test(mixed.text), true);
    is("one scheduled and one left: and that pressing again goes on with the other", /Press the button again to go on/.test(mixed.text), true);

    part("(2) The answer to an ask never says a link is on its way");
    const sent = await show({ status: "sent" });
    is("no 'is on its way'", /is on its way/i.test(sent.text), false);
    is("says the email may not go out", /may not go out/i.test(sent.text), true);
    is("gives the support address", sent.hrefs.includes(SUPPORT), true);
    is("promises no answer time", ANSWER_TIME.test(sent.text), false);

    part("(3) The link cannot be emailed (full)");
    const full = await show({ status: "full", store: "refusalspent" });
    is("says why", /used up/i.test(full.text), true);
    is("gives the support address", full.hrefs.includes(SUPPORT), true);
    is("data protection authority", COMPLAINT.test(full.text), true);
    is("court", COURT.test(full.text), true);
    is("promises no answer time", ANSWER_TIME.test(full.text), false);

    part("(4) The help answer");
    const answer = HELP_SECTIONS.flatMap((s) => s.items).find((item) => item.q === "Can I have it deleted?");
    const words = (answer?.a ?? []).join(" ");
    is("the answer is found", Boolean(answer), true);
    is("never promises the link is always emailed", /If the store knows it, we email you a link/.test(words), false);
    // Rule 23 (claude5/rights-budget): was /says why/ (a refusal's reason); a store that cannot do it now schedules it,
    // and the help says the page gives the date ("says by when"), with the address to write to kept.
    is("says a store may not be able to do it at once, by when it is done, and where to write", /support@marktmorgen\.com/.test(words) && /scheduled/i.test(words) && /says by when/i.test(words), true);

    part("(5) The Privacy Policy and the page's own opening say the same");
    const plain = (file: string) => readFileSync(join(process.cwd(), file), "utf8").replace(/\{" "\}/g, " ").replace(/\s+/g, " ");
    const policy = plain("app/privacy/page.tsx");
    const opening = /If a store knows it, we email it a link that works for an hour/.test(policy);
    is("the Privacy Policy never promises the link is always emailed", opening, false);
    is("the Privacy Policy says where to write when it does not come", /we try to email it a link.{0,1500}support@marktmorgen\.com/.test(policy), true);
    is("the deletion page's opening never promises the link is always emailed", /nobody to ask: we email you a link/.test(plain("app/privacy/delete/page.tsx")), false);
  } finally {
    if (keyBefore === undefined) delete process.env.NIMBUS_DATA_KEY;
    else process.env.NIMBUS_DATA_KEY = keyBefore;
  }
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
