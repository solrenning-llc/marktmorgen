/**
 * The studio's view of each product's pre-orders and a person's pre-orders in the copy of their data, read only in
 * their exact shape (CX-123 rule 24; rule-30 siblings of waitingCount, tests/preorders-waiting-unknown.test.ts).
 * Synthetic only: the in-memory Redis double, every fetch answers 404.
 *
 * Before: lib/preorders.ts read an HVALS or HGETALL that answered no reply, a number or text as "no pre-orders":
 *   1. preorderViews: the studio said a product had no pre-orders (and offered "Take pre-orders" as if none were
 *      ever taken) while buyers who paid waited; the pre-order switch answered ok with 0 waiting;
 *   2. preordersOf: the copy of a person's data was handed over without their paid pre-orders in it.
 * Now: an unknown read throws UnknownReplyError; the switch answers 503 "preorders_unread" (its day is saved, the
 * counts are not invented); the studio says the pre-orders could not be read; the copy is not made.
 * And the day's own HSET/HDEL answered in another shape throws PreorderDayUnconfirmed: the switch answers 502
 * "day_unconfirmed", never ok and never "Saved." (independent review of #3005, LEVE).
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductLink, storeForEmail } from "@/lib/store";
import { setSoon } from "@/lib/waitlist";
import { preorderViews, preordersOf, setExpectedDay } from "@/lib/preorders";
import { UnknownReplyError } from "@/lib/redis-reply";
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { POST as preorderRoute } from "@/app/api/store/preorder/route";
import { WaitlistPanel } from "@/components/waitlist-panel";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "preorders.views@example.com";
const BUYER = "buyer@example.com";
const HANDLE = "previews";
const ORIGIN = "https://marktmorgen.com";
const original = redis.pipeline.bind(redis);
const WAITING = JSON.stringify({ to: BUYER, at: 1_700_000_000, pi: "" });
const CHECKOUT = `cs_test_${"b".repeat(24)}`;
const DAY = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

const answer = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

/** Every `command` of `key` answers `reply` while `work` runs; everything else is real. */
async function withBent<T>(command: string, key: string, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original(commands);
    return replies.map((r, i) => (commands[i][0] === command && commands[i][1] === key ? reply : r));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** Each `[command, key]` given is never run and answers `reply` while `work` runs (lost in transit); everything else is real. */
async function withLost<T>(gone: [string, string][], reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const lost = (c: (string | number)[]) => gone.some(([command, key]) => c[0] === command && c[1] === key);
    const kept = commands.filter((c) => !lost(c));
    const replies = kept.length ? await original(kept) : [];
    let next = 0;
    return commands.map((c) => (lost(c) ? reply : replies[next++]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function rejection(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "resolved";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

const SHAPES: [string, unknown][] = [
  ["no reply", undefined],
  ["a number", 3],
  ["text", "OK"],
  ["a list with a number in it", [WAITING, 7]],
  ["a list with text that is not a pre-order", ["not json"]],
];
const HASH_SHAPES: [string, unknown][] = [
  ["no reply", undefined],
  ["a number", 3],
  ["text", "OK"],
  ["an odd list", [CHECKOUT]],
  ["a list with a number in it", [CHECKOUT, 7]],
  ["a list whose value is not a pre-order", [CHECKOUT, "not json"]],
];
const DAY_SHAPES: [string, unknown][] = [
  ["no reply", undefined],
  ["a number", 3],
  ["text", "OK"],
  ["an odd list", ["p"]],
  ["a list with a number in it", ["p", 7]],
];

const WRITE_SHAPES: [string, unknown][] = [
  ["no reply", undefined],
  ["text", "OK"],
  ["a number that is not one write", 2],
  ["a negative number", -1],
  ["a list", [1]],
];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Pre Views", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const sid = (await storeForEmail(OWNER))!.statsId!;
  const store = async () => (await storeForEmail(OWNER))!;
  const dayKey = `nl:wl:${sid}:pre`;

  /** A product coming soon, with a link in it; with one buyer who paid for a pre-order and waits (or none). */
  const setUp = async (title: string, withBuyer = true) => {
    const made = await addProduct(OWNER, title, "", "29", null);
    if (!made.ok) throw new Error("no product");
    const pid = made.product.id;
    await setProductLink(OWNER, pid, "https://example.com/the-thing");
    await setSoon(await store(), pid, true);
    const key = `nl:pre:${sid}:${pid}`;
    if (withBuyer) await redis.pipeline([["HSET", key, CHECKOUT, WAITING]]);
    return { pid, key };
  };
  const switchDay = (pid: string) =>
    preorderRoute(new NextRequest(`${ORIGIN}/api/store/preorder`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ id: pid, day: DAY, agree: true }) }));
  const scopeOf = async (productIds: string[]) => ({ store: await store(), statsId: sid, productIds, email: BUYER }) as unknown as ErasureScope;

  part("Healthy control: read exactly");
  const { pid: a, key: aKey } = await setUp("Course A");
  const { pid: b } = await setUp("Course B", false);
  is("the studio sees the buyer who waits, and nothing for a product nobody pre-ordered", await preorderViews(await store(), [a, b]), { [a]: { day: null, waiting: 1, given: 0, refunded: 0 } });
  is("the switch answers the view with its day and the buyer who waits", await switchDay(a).then((r) => r.json()), { ok: true, view: { day: DAY, waiting: 1, given: 0, refunded: 0 } });
  is("the copy of the buyer's data has their pre-order", (await preordersOf(await store(), [a, b], BUYER)).map((p) => [p.product, p.checkout, p.to]), [[a, CHECKOUT, BUYER]]);
  is("and the copier hands it over", (await COPIERS["lib/preorders.ts"](await scopeOf([a, b]))).length, 1);

  for (const [label, reply] of SHAPES) {
    part(`Unknown (${label}): the HVALS of a product's pre-orders answers in another shape`);
    const shop = await store();
    is(`(${label}) preorderViews says it does not know, never "no pre-orders"`, await withBent("HVALS", aKey, reply, () => rejection(() => preorderViews(shop, [a, b]))), "UnknownReplyError");
    const switched = await withBent("HVALS", aKey, reply, () => switchDay(a));
    is(`(${label}) the switch answers 503 "preorders_unread", never 0 waiting`, await answer(switched), [503, "preorders_unread"]);
  }

  for (const [label, reply] of DAY_SHAPES) {
    part(`Unknown (${label}): the HGETALL of the expected days answers in another shape`);
    const shop = await store();
    is(`(${label}) preorderViews says it does not know, never "no day"`, await withBent("HGETALL", dayKey, reply, () => rejection(() => preorderViews(shop, [a, b]))), "UnknownReplyError");
  }
  {
    const shop = await store();
    is("a kept day that is not a day, for a product asked about, is unknown", await withBent("HGETALL", dayKey, [a, "someday"], () => rejection(() => preorderViews(shop, [a]))), "UnknownReplyError");
  }

  for (const [label, reply] of HASH_SHAPES) {
    part(`Unknown (${label}): the HGETALL of a product's pre-orders for the copy answers in another shape`);
    const shop = await store();
    is(`(${label}) preordersOf says it does not know, never "no pre-orders"`, await withBent("HGETALL", aKey, reply, () => rejection(() => preordersOf(shop, [a, b], BUYER))), "UnknownReplyError");
    const scope = await scopeOf([a, b]);
    is(`(${label}) so the copy is not made without them`, await withBent("HGETALL", aKey, reply, () => rejection(() => COPIERS["lib/preorders.ts"](scope))), "UnknownReplyError");
  }

  // The independent review of #3005 (LEVE): "Saved." rested on an HSET/HDEL whose reply was never checked.
  const { pid: c, key: cKey } = await setUp("Course C");
  const dayOf = async (pid: string) => (await redis.pipeline([["HGET", dayKey, pid]]))[0];
  const stopDay = (pid: string) =>
    preorderRoute(new NextRequest(`${ORIGIN}/api/store/preorder`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ id: pid, day: null }) }));
  const failure = async (work: () => Promise<unknown>) => {
    try {
      await work();
      return "resolved";
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  };
  for (const [label, reply] of WRITE_SHAPES) {
    part(`Unconfirmed (${label}): the HSET of the expected day answers in another shape`);
    const shop = await store();
    is(`(${label}) setExpectedDay says the day is not confirmed, never "saved"`, await withLost([["HSET", dayKey]], reply, () => failure(() => setExpectedDay(shop, c, DAY))), "PreorderDayUnconfirmed");
    const switched = await withLost([["HSET", dayKey]], reply, () => switchDay(c));
    is(`(${label}) the switch answers 502 "day_unconfirmed", never ok`, await answer(switched), [502, "day_unconfirmed"]);
    const both = await withLost([["HSET", dayKey], ["HVALS", cKey]], reply, () => switchDay(c));
    is(`(${label}) with its pre-orders unread too, still 502 "day_unconfirmed", never "Saved."`, await answer(both), [502, "day_unconfirmed"]);
    is(`(${label}) and the day was indeed not saved`, await dayOf(c), null);
  }
  part("Healthy control: the day is saved, moved and stopped with a confirmed write");
  is("taking pre-orders saves the day", [await answer(await switchDay(c)), await dayOf(c)], [[200, "ok"], DAY]);
  is("moving to the same day again (HSET answers 0) is still saved", await answer(await switchDay(c)), [200, "ok"]);
  for (const [label, reply] of WRITE_SHAPES) {
    part(`Unconfirmed (${label}): the HDEL that stops pre-orders answers in another shape`);
    const stopped = await withLost([["HDEL", dayKey]], reply, () => stopDay(c));
    is(`(${label}) the switch answers 502 "day_unconfirmed", never ok`, await answer(stopped), [502, "day_unconfirmed"]);
    is(`(${label}) and the day still stands`, await dayOf(c), DAY);
  }
  is("control: stopping with a confirmed HDEL answers ok and lets the day go", [await answer(await stopDay(c)), await dayOf(c)], [[200, "ok"], null]);
  {
    const panel = readFileSync("components/waitlist-panel.tsx", "utf8");
    is("the panel has its own words for an unconfirmed day, not \"Saved.\"", /day_unconfirmed: "(?!Saved)/.test(panel), true);
    is("and shows nothing it cannot vouch for after one", /answer\.error === "preorders_unread" \|\| answer\.error === "day_unconfirmed"/.test(panel), true);
  }

  part("The studio says the pre-orders could not be read");
  {
    const html = renderToStaticMarkup(
      createElement(WaitlistPanel, { productId: a, initial: { soon: true, confirmed: 0, waiting: 0, launch: null }, suggestedAddress: "", preorders: null, preordersUnread: true, price: "$29.00" }),
    );
    is("it says so", html.includes("Pre-orders could not be read just now"), true);
    is("it does not offer to take pre-orders as if none were ever taken", html.includes("Take pre-orders"), false);
    is("putting it on sale still says waiting buyers get it", html.includes("Any pre-orders are handed over the moment it goes on sale"), true);
    const read = renderToStaticMarkup(
      createElement(WaitlistPanel, { productId: a, initial: { soon: true, confirmed: 0, waiting: 0, launch: null }, suggestedAddress: "", preorders: null, price: "$29.00" }),
    );
    is("control: read, with none, it offers to take pre-orders", [read.includes("Take pre-orders"), read.includes("could not be read")], [true, false]);
  }
  {
    const page = readFileSync("app/studio/page.tsx", "utf8");
    is("the studio page never reads an unread view as none", /preorderViews\(.*\.catch\(\(\) => \(\{\}\)\)/.test(page), false);
    const editor = readFileSync("components/product-editor.tsx", "utf8");
    is("the editor passes an unread view on to the panel", editor.includes("preordersUnread={preorders === null}"), true);
  }

  // Rule-30 sibling on the same panel (studio inventory, app/studio/page.tsx:1750): the waitlist's own read failing
  // was caught as {}, so the panel drew "Coming soon" unchecked with 0 confirmed, a state nobody read.
  part("The studio says the waitlist could not be read, never off with 0 confirmed");
  {
    const html = renderToStaticMarkup(
      createElement(WaitlistPanel, { productId: a, initial: null, waitlistUnread: true, suggestedAddress: "", preorders: null, price: "$29.00" } as Parameters<typeof WaitlistPanel>[0]),
    );
    is("it says so", html.includes("The waitlist could not be read just now"), true);
    is("it draws no coming-soon switch it cannot vouch for", html.includes('type="checkbox"'), false);
    is("nor a count of confirmed addresses", html.includes("confirmed address"), false);
    is("nor a way to put it on sale", html.includes("Put it on sale"), false);
    const read = renderToStaticMarkup(
      createElement(WaitlistPanel, { productId: a, initial: null, suggestedAddress: "", preorders: null, price: "$29.00" }),
    );
    is("control: read, with no waitlist, it offers the switch", [read.includes('type="checkbox"'), read.includes("could not be read")], [true, false]);
    const page = readFileSync("app/studio/page.tsx", "utf8");
    is("the studio page never reads an unread waitlist as none", /waitlistViews\(.*\.catch\(\(\) => \(\{\}\)\)/.test(page), false);
    is("and logs it", /waitlistViews\(.*\.catch\(\(error\) => \{ console\.error\("the studio could not read its waitlists", error\); return null; \}\)/.test(page), true);
    const editor = readFileSync("components/product-editor.tsx", "utf8");
    is("the editor passes an unread waitlist on to the panel", editor.includes("waitlistUnread={waitlists === null}"), true);
  }
  done();
}

main();
