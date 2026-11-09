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
 * The same holds for the counts and states on Today that a failed read turned into "none" (VR, item 2), held in the
 * parts after the money ones:
 *  - closingOf (lib/plan-closing.ts) failed into null, the same as "your store does not close", so the closing card
 *    and its day were not shown to a creator whose plan had ended;
 *  - readListings for the numbers (lib/catalog.ts) failed into null, so the whole Numbers panel (and the warning that
 *    buyers could not pay, which sits in it) was gone with no word;
 *  - readSalesGoal failed into { cents: 0 }, "no goal" (it catches its own failures into the unknown goal today, so
 *    the page's own fallback is held on the source as well);
 *  - answersUsed, welcomesOffered, nudgesThisMonth, yearlyAsksThisMonth and winbacksSent failed into 0, so a
 *    creator read "0 of 300 AI attempts used" or "Sent this month: 0" when the count was not known.
 *
 * And the rest of what Today read that way (VR, item 2), held in the last parts:
 *  - aiLeft (lib/ai.ts) failed into 0, so the bio, the store questions and the media kit said "0 left this month";
 *  - readTeam (lib/team.ts) failed into null, so the Team card said "Invite up to ..." to an owner with a team;
 *  - readCards (lib/catalog.ts) failed into no products, so the welcome offer said "Add a paid product first", the
 *    leaving-visitor offer "Add something free", and the editors that pick products (sections, collections, buy
 *    buttons, the checkout script, short links) were drawn with none, ready to save over the real ones;
 *  - readLinks (lib/short-links.ts) failed into no links, the short links shown as if none were made;
 *  - secondStepWay (lib/team.ts) failed into "set_up", so a member held at a team's door who has a passkey was told
 *    to set up a second step.
 *
 * Synthetic only: the Redis stand-in, a stubbed Stripe and stores made here.
 */
import { NextRequest } from "next/server";
import { cloneElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCall, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import StudioPage from "@/app/studio/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { savePaidPeriod } from "@/lib/closing-holds";
import { UNKNOWN_SALES_GOAL_CENTS } from "@/lib/sales-goal";
import { AI_ALLOWANCE_UNKNOWN } from "@/components/ai-assist";
import { PairsEditor } from "@/components/pairs-editor";
import { createElement } from "react";
import { SECOND_STEP_WORDS, putMember, setRequireTwoStep } from "@/lib/team";
import { makePasskey } from "./passkey-world";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.STRIPE_SECRET_KEY = "sk_test_studio_money_reads_only";

/** The client components the page hands its figures to, by name, as the last page walked drew them. */
let drawn: ReactElement<Record<string, unknown>>[] = [];

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
    if (typeof type === "function") drawn.push(node as ReactElement<Record<string, unknown>>);
    await words(props.children, found, seen);
  }
  return found;
}

/** The element of the client component `name` the last page walked drew (esbuild may add a number to the name). */
function element(name: string): ReactElement<Record<string, unknown>> | null {
  const pattern = new RegExp(`^${name}\\d*$`);
  return drawn.find((one) => pattern.test((one.type as { name?: string }).name ?? "")) ?? null;
}

/** That component, drawn with `props` over what the page gave it, as the text a person reads. */
function drawnText(found: ReactElement<Record<string, unknown>> | null, props: Record<string, unknown> = {}): string {
  if (!found) return "";
  return renderToStaticMarkup(cloneElement(found, props)).replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
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
async function shown(email: string, fails: (command: unknown[], pipeline: unknown[][]) => boolean = () => false): Promise<string | null> {
  const session = await openSession(email);
  const kept = redis.pipeline;
  redis.pipeline = async (commands) => {
    if (commands.some((command) => fails(command as unknown[], commands as unknown[][]))) throw new Error("synthetic Redis outage");
    return kept.call(redis, commands);
  };
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
  drawn = [];
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
const CLOSES_ON = "Your plan has ended, and your store closes on";
const CLOSING_UNREAD = "We could not check just now when your store closes";
const NUMBERS_UNREAD = "We could not read your numbers just now";
const COUNT_UNREAD = "We could not check just now how many";

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
  // A member who paid for a long period that runs well past any closing day: the amount is the unused part.
  const nowS = Math.floor(Date.now() / 1000);
  await savePaidPeriod(closer, "sub_MoneyReadsMember2", { inv: "in_MoneyReadsMember2", amt: 40_000, cur: "usd", ps: nowS - 10 * 86_400, pe: nowS + 400 * 86_400, e: "member@buyers.example.com" });
  const owed = await shown(CLOSER);
  is("control: a member who paid past the day is shown with the amount, as before", [has(owed, "1 member has paid for time after"), /: \$[0-9][0-9,]*\.[0-9]{2} in all\./.test(owed ?? ""), has(owed, "Review and refund unused time now"), has(owed, UNUSED_UNREAD)], [true, true, true, false]);

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

  part("A closing store whose closing day could not be read");
  // closingOf reads the store's closing record (lib/plan-closing.ts, stateKey) in every case.
  const closingKey = `nl:plan:closing:${createHash("sha256").update(storeRef(closer)).digest("hex").slice(0, 40)}`;
  const closingDown = await shown(CLOSER, (command) => command[0] === "GET" && command[1] === closingKey);
  is("the page still renders when the closing day cannot be read", closingDown !== null, true);
  is("a failed read of the closing day is said, never taken for a store that does not close", has(closingDown, CLOSING_UNREAD), true);
  is("and it tells how to check again", has(closingDown, RELOAD), true);
  is("no closing day is shown as if it were known", has(closingDown, CLOSES_ON), false);
  const closingRead = await shown(CLOSER);
  is("control: read, the closing card is shown with no could-not-check notice", [has(closingRead, CLOSES_ON), has(closingRead, CLOSING_UNREAD)], [true, false]);

  part("Numbers whose products could not be read");
  const COUNTER = "money-reads-counts@example.com";
  await claimHandle(COUNTER, "moneyreadscounts", "Money reads counts", "");
  const countsStats = (await ensureStatsId(COUNTER))?.statsId;
  if (!countsStats) throw new Error("setup: statsId");
  await setSubscription(COUNTER, { customerId: "cus_MoneyReads03", subscriptionId: "sub_MoneyReads03", active: true, tier: "pro", period: paidPeriod() });
  const free = await addProduct(COUNTER, "Free guide", "", "0", null);
  const club = await addProduct(COUNTER, "Club", "", "10", { interval: "month", trialDays: 0, payments: 0 } as never);
  if (!free.ok || !club.ok) throw new Error("setup: products");
  const ids: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    const added = await addProduct(COUNTER, `Product ${i}`, "", "9", null);
    if (!added.ok) throw new Error(`setup: product ${i}`);
    ids.push(added.product.id);
  }
  const counter = await storeForEmail(COUNTER);
  if (!counter || counter.catalog.inline || !counter.catalog.id) throw new Error("setup: no catalog of records");
  const head = new Set(counter.catalog.head.map((listing) => listing.id));
  const off = ids.find((id) => !head.has(id));
  if (!off) throw new Error("setup: no product past the catalog head");
  const offKey = `nl:catalog:${counter.catalog.id}:l:${off}`;
  await shown(COUNTER);
  const numbersCalm = await shown(COUNTER);
  is("control: the numbers are shown, with no could-not-read notice", [has(numbersCalm, NUMBERS_UNREAD), element("StatsPanel") !== null], [false, true]);
  await redis.pipeline([["HINCRBY", `nl:cotrouble:${countsStats}`, new Date().toISOString().slice(0, 10), 1], ["HSET", `nl:cotrouble:${countsStats}`, "last", JSON.stringify({ at: Date.now() - 60_000, code: "x", message: "Your account cannot currently make live charges." })]]);
  // Only the reads of product records alone (the numbers' and the chart marks'): the shelf, which reads each record
  // with its extra part, has its own way of saying it could not be read.
  const numbersDown = await shown(COUNTER, (command, pipeline) => command.includes(offKey) && !pipeline.some((one) => String(one[1]).includes(":x:")));
  is("the page still renders when the numbers' products cannot be read", numbersDown !== null, true);
  is("numbers that could not be read are said so, never left out with no word", has(numbersDown, NUMBERS_UNREAD), true);
  is("and it tells how to check again", has(numbersDown, RELOAD), true);
  is("no numbers panel is drawn from a part of the products", element("StatsPanel"), null);
  is("buyers who could not pay are still warned of, numbers or not", has(numbersDown, `${TROUBLE_SHOWN} once in the last 7 days`), true);

  part("The month's sales goal that could not be read");
  const page = readFileSync("app/studio/page.tsx", "utf8");
  is("the page never takes a goal it could not read for no goal", /readSalesGoal\([^)]*\)\.catch\(\(\) => \(\{ cents: 0 \}\)\)/.test(page), false);
  await shown(COUNTER, (command) => command[0] === "GET" && command[1] === `nl:goal:${countsStats}`);
  is("guard: a goal that could not be read reaches the panel as unknown", element("StatsPanel")?.props.goal, UNKNOWN_SALES_GOAL_CENTS);

  part("Counts that could not be read: AI attempts, welcome offers, nudges, yearly asks, come-back offers");
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  const counts: { label: string; editor: string; prop: string; key: (command: unknown[]) => boolean; on: (props: Record<string, unknown>) => Record<string, unknown>; known: string }[] = [
    { label: "AI attempts used this month", editor: "AnswersEditor", prop: "used", key: (c) => c[0] === "GET" && String(c[1]).startsWith(`nl:ask:${countsStats}:`), on: () => ({}), known: "3 of " },
    { label: "people offered the welcome offer", editor: "WelcomeOfferEditor", prop: "offered", key: (c) => c[0] === "GET" && c[1] === `nl:wo:n:${countsStats}`, on: (p) => ({ offer: { ...(p.offer as object), percent: 10, coupon: "coupon_MoneyReads" } }), known: "Offered so far: 3." },
    { label: "nudges sent this month", editor: "NudgeEditor", prop: "sent", key: (c) => c[0] === "GET" && String(c[1]).startsWith(`nl:nudge:count:${countsStats}:`), on: (p) => ({ nudge: { ...(p.nudge as object), on: true } }), known: "Sent this month: 3" },
    { label: "yearly asks sent this month", editor: "YearlyAskEditor", prop: "sent", key: (c) => c[0] === "GET" && String(c[1]).startsWith(`nl:yearask:count:${countsStats}:`), on: (p) => ({ ask: { ...(p.ask as object), on: true } }), known: "Sent this month: 3" },
    { label: "come-back offers sent", editor: "WinBackEditor", prop: "sent", key: (c) => c[0] === "GET" && c[1] === `nl:wb:n:${countsStats}`, on: (p) => ({ winback: { ...(p.winback as object), percent: 10, coupon: "coupon_MoneyReads" } }), known: "Sent so far: 3." },
  ];
  await shown(COUNTER);
  for (const count of counts) {
    const read = element(count.editor);
    if (!read) throw new Error(`setup: ${count.editor} is not on the page`);
    is(`control: ${count.label}, read, reach the editor as a number`, typeof read.props[count.prop], "number");
    is(`control: ${count.label}, read, are shown as they are`, has(drawnText(read, { ...count.on(read.props), [count.prop]: 3 }), count.known), true);
  }
  for (const count of counts) {
    const down = await shown(COUNTER, (command) => count.key(command));
    is(`the page still renders when the ${count.label} cannot be read`, down !== null, true);
    const unread = element(count.editor);
    is(`${count.label} that could not be read reach the editor as unknown, never 0`, unread?.props[count.prop], null);
    const text = drawnText(unread, unread ? count.on(unread.props) : {});
    is(`${count.label} that could not be read are said so`, [has(text, COUNT_UNREAD), has(text, RELOAD)], [true, true]);
    is(`${count.label} that could not be read are never shown as 0`, /\b0 of |: 0\b/.test(text), false);
  }
  delete process.env.ANTHROPIC_API_KEY;

  part("The month's AI allowance that could not be read");
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  const AI_EDITORS: [string, string][] = [["DetailsForm", "left this month"], ["FaqEditor", "drafts left this month"], ["KitEditor", "drafts left this month"]];
  await shown(COUNTER);
  is("control: read, the studio's help gets the number left", typeof element("StudioHelp")?.props.left, "number");
  for (const [editor, words] of AI_EDITORS) {
    const read = element(editor);
    if (!read) throw new Error(`setup: ${editor} is not on the page`);
    is(`control: read, ${editor} says how many are left`, has(drawnText(read), words), true);
  }
  const aiDown = await shown(COUNTER, (command) => command[0] === "GET" && String(command[1]).startsWith(`nl:ai:${countsStats}:`));
  is("the page still renders when the AI allowance cannot be read", aiDown !== null, true);
  is("the studio's help gets an allowance it could not read as unknown, never 0", element("StudioHelp")?.props.left, null);
  for (const [editor] of AI_EDITORS) {
    const text = drawnText(element(editor));
    is(`${editor} says the allowance could not be checked`, has(text, AI_ALLOWANCE_UNKNOWN), true);
    is(`${editor} never says 0 left`, /\b0 (drafts )?left this month/.test(text), false);
  }
  delete process.env.ANTHROPIC_API_KEY;

  part("A team that could not be read");
  const counterStore = await storeForEmail(COUNTER);
  if (!counterStore?.sid) throw new Error("setup: no store id");
  await putMember(counterStore, "money-reads-helper@example.com", "editor");
  const teamCard = () => {
    const tools = (element("StudioTools")?.props.tools ?? []) as { title: string; text: string }[];
    return tools.find((tool) => tool.title === "Team")?.text ?? "";
  };
  await shown(COUNTER);
  is("control: read, the Team card counts the people who help", teamCard(), "1 person helps run this store.");
  await shown(COUNTER, (command) => command[0] === "GET" && command[1] === `nl:team:${counterStore.sid}`);
  is("a team that could not be read is said so on its card", teamCard(), "We could not check just now who helps run this store.");

  part("Products whose names could not be read");
  const titlesKey = `nl:catalog:${counter.catalog.id}:t`;
  const PICKERS = ["ExitOfferEditor", "StoreLayoutEditor", "CollectionsEditor", "BuyButtonEditor", "CheckoutScriptEditor", "WelcomeOfferEditor", "ShortLinks"];
  await shown(COUNTER);
  for (const picker of PICKERS) is(`control: read, ${picker} is drawn`, element(picker) !== null, true);
  const cardsDown = await shown(COUNTER, (command) => command[0] === "HGETALL" && command[1] === titlesKey);
  is("the page still renders when the products' names cannot be read", cardsDown !== null, true);
  is("products that could not be read are said so", [has(cardsDown, "We could not read your products just now"), has(cardsDown, RELOAD)], [true, true]);
  for (const picker of PICKERS) is(`${picker} is never drawn with no products in place of the real ones`, element(picker), null);
  is("never 'Add a paid product first' to a store that has them", has(drawnText(element("WelcomeOfferEditor")), "Add a paid product first"), false);
  is("never 'Add something free' to a store that gives something away", has(drawnText(element("ExitOfferEditor")), "Add something free"), false);
  // "Goes well with" (components/pairs-editor.tsx) picks among the same names: not read, it is said so on each product,
  // never left out with no word as if the store had no other product to pick (VR 2).
  const editor = element("ProductEditor");
  const pairChoices = editor?.props.pairChoices;
  is("the product editor is told the picks' names could not be read, never given none", [editor !== null, pairChoices], [true, null]);
  const pairsText = renderToStaticMarkup(createElement(PairsEditor, { productId: "p1", initial: ["p2"], choices: pairChoices as never })).replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/\s+/g, " ");
  is("'Goes well with' is still drawn, saying its picks could not be read and are kept, with how to check again", [has(pairsText, "Goes well with"), has(pairsText, "We could not read your other products' names just now"), has(pairsText, "kept as they are"), has(pairsText, RELOAD)], [true, true, true, true]);

  part("Short links that could not be read");
  const linksDown = await shown(COUNTER, (command) => command[0] === "HVALS" && command[1] === `nl:slink:store:${countsStats}`);
  is("the page still renders when the short links cannot be read", linksDown !== null, true);
  is("short links that could not be read are said so", [has(linksDown, "We could not read your short links just now"), has(linksDown, RELOAD)], [true, true]);
  is("never drawn as no links made", element("ShortLinks"), null);

  part("A member held at a team's door whose second step could not be read");
  const DOOR_OWNER = "money-reads-door@example.com";
  const MEMBER = "money-reads-member@example.com";
  await claimHandle(DOOR_OWNER, "moneyreadsdoor", "Money reads door", "");
  const door = (await ensureStoreId(DOOR_OWNER)) ?? (await storeForEmail(DOOR_OWNER));
  if (!door?.sid) throw new Error("setup: no store id");
  await putMember(door, MEMBER, "editor");
  await setRequireTwoStep(door, true, DOOR_OWNER);
  await makePasskey(MEMBER, "cred-money-reads-member").keep();
  const held = await shown(MEMBER);
  is("control: read, the member is told to log in again with the passkey", has(held, SECOND_STEP_WORDS.passkey.title), true);
  const twoStepKey = (command: unknown[]) => command[0] === "GET" && /^nl:2fa:/.test(String(command[1]));
  const doorDown = await shown(MEMBER, (command) => twoStepKey(command) || (command[0] === "GET" && /^nl:pk:[0-9a-f]{40}$/.test(String(command[1]))));
  is("the page still renders when the second step cannot be read", doorDown !== null, true);
  is("never told to set up a second step it may already have", has(doorDown, SECOND_STEP_WORDS.set_up.title), false);
  is("the second step that could not be read is said so", [has(doorDown, "We could not check just now how you log in with a second step"), has(doorDown, RELOAD)], [true, true]);
  // A way forward, as the other ways of this notice have one: the login page, where the second step is asked for anyway.
  // next/link is not a plain function component, so the walk does not keep it: its href is read in the branch drawn.
  const doorSource = readFileSync("app/studio/page.tsx", "utf8");
  const unreadBranch = doorSource.slice(doorSource.indexOf(') : secondStep === "unread" ? ('), doorSource.indexOf(") : secondStep ? ("));
  is("with a way forward: a link to the login page", [/<Link href="\/signin"[^>]*>\s*Go to the login page\s*<\/Link>/.test(unreadBranch), has(doorDown, "Go to the login page")], [true, true]);

  part("One sentence to reload, on the whole of Today");
  // The studio's notices say "Reload this page in a moment to check again."; the AI allowance and the calls not read
  // said it in other words (a minute, try again, the page). One sentence, the simplest, everywhere on this page.
  const source = readFileSync("app/studio/page.tsx", "utf8");
  is("the AI allowance not read ends in the same sentence", AI_ALLOWANCE_UNKNOWN.endsWith(RELOAD), true);
  is("the calls not read from Stripe end in it too", [source.includes("Nothing is lost; reload the page in a moment."), source.includes("Your calls could not be read from Stripe just now. Nothing is lost. Reload this page in a moment to check again.")], [false, true]);

  done();
}

void main();
