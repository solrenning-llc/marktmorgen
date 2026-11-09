/**
 * Money the studio could not read is said so, never hidden (VR, item 2; rule 24). On Today (app/studio/page.tsx)
 * three readings about money were read tolerantly, and a failed read hid the warning it feeds:
 *
 *  - readTrouble (lib/checkout-trouble.ts) failed into "no refusal this week" ({ week: 0 }), so the warning that
 *    Stripe would not open a checkout, and those buyers could not pay, was not shown;
 *  - holdCounts (lib/closing-holds.ts) failed into null, the same as "every membership's payments are paused", so a
 *    closing store's creator was not told some members may still be charged;
 *  - unusedSummary (lib/closing-refunds.ts) failed into null, the same as "no member paid for time after the
 *    closing day", so the members and the amounts to be refunded were not shown.
 *
 * The contract held here, with the real page, a real store and the Redis stand-in made to fail one read at a time:
 *  - each failed read shows a plain notice that it could not be checked just now (the closing ones in the words of
 *    the closing email, lib/plan-closing.ts), and never the figure as if it were none;
 *  - the rest of the page still renders (the closing card, the numbers, the other notices);
 *  - read as it should be, the page is as before: no notice when nothing is wrong, the warning when there is (controls).
 *
 * And paidCallsRead (lib/calls.ts), read the same way into null: there "Upcoming calls" already says the calls could
 * not be read from Stripe (calls === null), so it is held here as a guard, green before the fix.
 *
 * Synthetic only: the Redis stand-in, a stubbed Stripe and stores made here.
 */
import { NextRequest } from "next/server";
import { isValidElement } from "react";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import StudioPage from "@/app/studio/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.STRIPE_SECRET_KEY = "sk_test_studio_money_reads_only";

/** Every string shown anywhere in the page's tree, its parts waited for as React waits for them. */
async function words(node: unknown, found: string[] = [], seen = new Set<unknown>()): Promise<string[]> {
  if (typeof node === "string") {
    found.push(node);
    return found;
  }
  if (!node || typeof node !== "object" || seen.has(node)) return found;
  seen.add(node);
  if (typeof (node as PromiseLike<unknown>).then === "function") return words(await node, found, seen);
  if (Array.isArray(node)) {
    for (const child of node) await words(child, found, seen);
    return found;
  }
  if (isValidElement(node)) {
    const { type, props } = node as { type: unknown; props: Record<string, unknown> };
    if (typeof type === "function" && type.constructor.name === "AsyncFunction") return words(await (type as (p: unknown) => Promise<unknown>)(props), found, seen);
    await words(props.children, found, seen);
  }
  return found;
}

/** Stripe answers an empty list to every read, or an error to the checkout sessions read when `callsDown`. */
let callsDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request: " + url.hostname);
  const method = init?.method ?? "GET";
  if (method !== "GET") throw new Error("Unexpected provider operation: " + method + " " + url.pathname);
  if (callsDown && url.pathname === "/v1/checkout/sessions") return Response.json({ error: { message: "synthetic outage" } }, { status: 500 });
  return Response.json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/**
 * The page as its owner sees it, as one text, with every Redis command `fails` picks answered by a throw, as a read
 * that did not reach Redis. Null when the page itself did not render.
 */
async function shown(email: string, fails: (command: unknown[]) => boolean = () => false): Promise<string | null> {
  const session = await openSession(email);
  const kept = redis.pipeline;
  redis.pipeline = async (commands) => {
    if (commands.some((command) => fails(command as unknown[]))) throw new Error("synthetic Redis outage");
    return kept.call(redis, commands);
  };
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
  try {
    return (await words(await StudioPage({ searchParams: Promise.resolve({}) }))).join(" ").replace(/\s+/g, " ");
  } catch (error) {
    console.log("PAGE_ERROR:", error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    redis.pipeline = kept;
    answering(null);
  }
}

const has = (text: string | null, needle: string) => (text ?? "").includes(needle);

const TROUBLE_UNREAD = "We could not check just now whether Stripe opened every checkout";
const TROUBLE_SHOWN = "Stripe would not open a checkout";
const HOLDS_UNREAD = "We could not check just now whether every membership's payments are paused.";
const UNUSED_UNREAD = "We could not check just now which members paid for time after";
const RELOAD = "Reload this page in a moment to check again.";

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();

  part("A buyer who could not pay: Stripe's refusals, read or not");
  const SELLER = "money-reads-numbers@example.com";
  await claimHandle(SELLER, "moneyreadsnumbers", "Money reads numbers", "");
  const statsId = (await ensureStatsId(SELLER))?.statsId;
  if (!statsId) throw new Error("setup: statsId");
  await addProduct(SELLER, "Guide", "", "19", null);
  // Once without a failure, so what a first opening writes is already there.
  await shown(SELLER);
  const troubleKey = `nl:cotrouble:${statsId}`;
  const calm = await shown(SELLER);
  is("control: the page renders for its owner", calm !== null, true);
  is("control: with no refusal recorded, neither the warning nor the could-not-check notice", [has(calm, TROUBLE_SHOWN), has(calm, TROUBLE_UNREAD)], [false, false]);
  const troubleDown = await shown(SELLER, (command) => command[1] === troubleKey);
  is("the page still renders when the refusals cannot be read", troubleDown !== null, true);
  is("a failed read of Stripe's refusals is said, never taken for none", has(troubleDown, TROUBLE_UNREAD), true);
  is("and it tells how to check again", has(troubleDown, RELOAD), true);
  is("no count is shown as if it were known", has(troubleDown, TROUBLE_SHOWN), false);
  await redis.pipeline([["HINCRBY", troubleKey, new Date().toISOString().slice(0, 10), 2], ["HSET", troubleKey, "last", JSON.stringify({ at: Date.now() - 60_000, code: "x", message: "Your account cannot currently make live charges." })]]);
  const refused = await shown(SELLER);
  is("control: refusals read are warned of as before, with no could-not-check notice", [has(refused, `${TROUBLE_SHOWN} 2 times in the last 7 days`), has(refused, TROUBLE_UNREAD)], [true, false]);

  part("A closing store: memberships not paused, and time paid for after the closing day");
  const CLOSER = "money-reads-closing@example.com";
  await claimHandle(CLOSER, "moneyreadsclosing", "Money reads closing", "");
  await ensureStatsId(CLOSER);
  await setSubscription(CLOSER, { customerId: "cus_MoneyReads01", subscriptionId: "sub_MoneyReads01", active: true, tier: "creator", period: paidPeriod() });
  await setSubscription(CLOSER, { active: false });
  const closer = await storeForEmail(CLOSER);
  if (!closer?.planEndedAt) throw new Error("setup: the plan did not end");
  const folder = await storeFolder(storeRef(closer));
  const workKey = `nl:closing:work:${folder}`;
  const paidKey = `nl:closing:paid:${folder}`;
  await shown(CLOSER);
  const closingCalm = await shown(CLOSER);
  is("control: the closing card is shown", has(closingCalm, "Your plan has ended, and your store closes on"), true);
  is("control: nothing failed, so no could-not-check notice", [has(closingCalm, HOLDS_UNREAD), has(closingCalm, UNUSED_UNREAD)], [false, false]);

  const holdsDown = await shown(CLOSER, (command) => command[0] === "HKEYS" && command[1] === workKey);
  is("the page and its closing card still render when the hold cannot be read", has(holdsDown, "Your plan has ended, and your store closes on"), true);
  is("a failed read of the hold is said, never taken for every membership paused", has(holdsDown, HOLDS_UNREAD), true);
  is("and the creator is told what to do meanwhile", has(holdsDown, "If a member is charged before then, please refund them from Stripe."), true);
  is("the unused time, read, is not said to be unread", has(holdsDown, UNUSED_UNREAD), false);

  const unusedDown = await shown(CLOSER, (command) => command[0] === "HGETALL" && command[1] === paidKey);
  is("the page and its closing card still render when the members' payments cannot be read", has(unusedDown, "Your plan has ended, and your store closes on"), true);
  is("a failed read of the members' payments is said, never taken for no member", has(unusedDown, UNUSED_UNREAD), true);
  is("with the way to the refunds' own review, which reads them again", has(unusedDown, "Review and refund unused time now"), true);
  is("and it tells how to check again", has(unusedDown, RELOAD), true);
  is("the hold, read, is not said to be unread", has(unusedDown, HOLDS_UNREAD), false);

  await redis.pipeline([["HSET", workKey, "f:sub_MoneyReadsMember1", "1"]]);
  const unpaused = await shown(CLOSER);
  is("control: a membership not paused is warned of as before", [has(unpaused, "1 membership's payments are not paused yet: we try again every day"), has(unpaused, HOLDS_UNREAD)], [true, false]);

  part("Upcoming calls that could not be read from Stripe (guard: already said)");
  const HOST = "money-reads-calls@example.com";
  await claimHandle(HOST, "moneyreadscalls", "Money reads calls", "");
  await ensureStatsId(HOST);
  await setStripeAccount(HOST, "acct_1MoneyReadsCall1", true);
  await setSubscription(HOST, { customerId: "cus_MoneyReads02", subscriptionId: "sub_MoneyReads02", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(HOST, "Coaching call", "", "80", null);
  if (!made.ok) throw new Error("setup: no product");
  const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
  await setProductCall(HOST, made.product.id, { kind: "weekly", minutes: 60, tz: "America/New_York", weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1, room: "https://example.com/room", video: false, meet: null } as unknown as CallSetup);
  await shown(HOST);
  const callsCalm = await shown(HOST);
  is("control: the calls are read and none is booked", [has(callsCalm, "Upcoming calls"), has(callsCalm, "Nothing booked yet.")], [true, true]);
  callsDown = true;
  const callsUnread = await shown(HOST);
  callsDown = false;
  is("calls Stripe could not give are said so, with the section still there", [has(callsUnread, "Upcoming calls"), has(callsUnread, "Your calls could not be read from Stripe just now.")], [true, true]);
  is("never as nothing booked", has(callsUnread, "Nothing booked yet."), false);

  done();
}

void main();
