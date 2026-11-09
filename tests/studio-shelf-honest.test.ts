/**
 * A product read that failed never takes the whole studio down, and numbers that were not shown say why (VR, item 2;
 * rule 24). On Today (app/studio/page.tsx):
 *
 *  - the shelf (lib/catalog.ts studioShelf) was awaited with no catch: when the record of a product past the
 *    catalog's head could not be read, the page ended in its error and the creator had no studio at all;
 *  - the call products (readKind(store, "call")), read the same way, did the same (rule 30: the same defect, the
 *    same page);
 *  - the kept reading of the visits (lib/store-readings.ts keptStats) was read as `.then(kept => kept, () => null)`:
 *    the Numbers panel was gone with no word both when the day's readings were used and when the reading failed,
 *    and with it the warning that buyers could not pay, which sits over the numbers.
 *
 * The contract held here, with the real page, real stores and the Redis stand-in made to fail one read at a time:
 *  - a shelf that could not be read leaves the rest of the studio working, and the products' place says, in plain
 *    words and as a status, that they could not be read just now, with no count and no empty list in their place;
 *  - call products that could not be read are said so where the upcoming calls go, with the rest still there;
 *  - the day's readings used are said so, with when they come back (lib/store-readings.ts readingsBackAt); a reading
 *    that failed is said so, with how to check again; the two are never said in each other's words; neither makes
 *    a new read;
 *  - read as it should be, the page is as before (controls).
 *
 * Synthetic only: the Redis stand-in, a stubbed Stripe and stores made here.
 */
import { NextRequest } from "next/server";
import { isValidElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setSubscription, storeForEmail } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import StudioPage from "@/app/studio/page";
import { STORE_READINGS_PER_DAY, readingsBackAt } from "@/lib/store-readings";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.STRIPE_SECRET_KEY = "sk_test_studio_shelf_honest_only";

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
    // A status notice is marked so: its words are kept apart too, to check what it says and that it is a status.
    if (props.role === "status") statuses.push((await words(props.children)).join(" ").replace(/\s+/g, " "));
    await words(props.children, found, seen);
  }
  return found;
}
let statuses: string[] = [];

/** The element of the client component `name` the last page walked drew (esbuild may add a number to the name). */
function element(name: string): ReactElement<Record<string, unknown>> | null {
  const pattern = new RegExp(`^${name}\\d*$`);
  return drawn.find((one) => pattern.test((one.type as { name?: string }).name ?? "")) ?? null;
}

/** Stripe answers an empty list to every read. */
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request: " + url.hostname);
  const method = init?.method ?? "GET";
  if (method !== "GET") throw new Error("Unexpected provider operation: " + method + " " + url.pathname);
  return Response.json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** Every Redis pipeline the page sent, to tell that a notice made no read of its own. */
let sent: unknown[][][] = [];

/**
 * The page as its owner sees it, as one text, with every Redis pipeline `fails` picks answered by a throw, as a read
 * that did not reach Redis, and `alter` given the replies of the others. Null when the page itself did not render.
 */
async function shown(
  email: string,
  fails: (command: unknown[], pipeline: unknown[][]) => boolean = () => false,
  alter: (pipeline: unknown[][], replies: unknown[]) => unknown[] = (_, replies) => replies,
): Promise<string | null> {
  const session = await openSession(email);
  const kept = redis.pipeline;
  redis.pipeline = async (commands) => {
    sent.push(commands as unknown[][]);
    if (commands.some((command) => fails(command as unknown[], commands as unknown[][]))) throw new Error("synthetic Redis outage");
    return alter(commands as unknown[][], await kept.call(redis, commands)) as never;
  };
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
  drawn = [];
  statuses = [];
  sent = [];
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
const status = (needle: string) => statuses.find((one) => one.includes(needle)) ?? null;

const SHELF_UNREAD = "We could not read all of your products just now";
const CALLS_UNREAD = "We could not read your call products just now";
const NUMBERS_UNREAD = "We could not read your numbers just now";
// The page writes its apostrophe as typeset (&rsquo;), as the notices beside it do.
const READINGS_USED = "Today\u2019s readings of your numbers are used";
const RELOAD = "Reload this page in a moment to check again.";
const TROUBLE_SHOWN = "Stripe would not open a checkout once in the last 7 days";

/** A store on a paid plan with `count` products, its catalog in records, and one product past the catalog's head. */
async function storeWith(email: string, handle: string, count: number) {
  await claimHandle(email, handle, `Shelf ${handle}`, "");
  const statsId = (await ensureStatsId(email))?.statsId;
  if (!statsId) throw new Error("setup: statsId");
  await setSubscription(email, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: paidPeriod() });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const added = await addProduct(email, `Product ${i}`, "", "9", null);
    if (!added.ok) throw new Error(`setup: product ${i}`);
    ids.push(added.product.id);
  }
  const store = await storeForEmail(email);
  if (!store || store.catalog.inline || !store.catalog.id) throw new Error("setup: no catalog of records");
  const head = new Set(store.catalog.head.map((listing) => listing.id));
  const off = ids.filter((id) => !head.has(id));
  if (!off.length) throw new Error("setup: no product past the catalog head");
  return { statsId, catalog: store.catalog.id, off };
}

/** Whether a pipeline reads this product's record with its extra part, as the shelf does (lib/catalog.ts readProducts). */
const shelfReadOf = (catalog: string, id: string) => (command: unknown[], pipeline: unknown[][]) =>
  command.includes(`nl:catalog:${catalog}:l:${id}`) && pipeline.some((one) => one.includes(`nl:catalog:${catalog}:x:${id}`));

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();

  part("A shelf that could not be read: a short catalog, read whole");
  const SHORT = "shelf-honest-short@example.com";
  const short = await storeWith(SHORT, "shelfhonestshort", 30);
  await shown(SHORT);
  const calm = await shown(SHORT);
  is("control: the page renders for its owner", calm !== null, true);
  is("control: the products are drawn, every one of them", (element("ProductEditor")?.props.products as unknown[] | undefined)?.length, 30);
  is("control: no could-not-read notice", has(calm, SHELF_UNREAD), false);
  const shelfDown = await shown(SHORT, shelfReadOf(short.catalog, short.off[0]));
  is("the page still renders when a product past the catalog's head cannot be read", shelfDown !== null, true);
  is("the products' place says they could not be read just now", has(shelfDown, SHELF_UNREAD), true);
  is("as a status, with how to check again", (status(SHELF_UNREAD) ?? "").includes(RELOAD), true);
  is("with no count in it, known or not", /\d/.test(status(SHELF_UNREAD) ?? "0"), false);
  is("no editor is drawn from an empty or partial list, as if the products were not there", element("ProductEditor"), null);
  is("the rest of the studio still works: the numbers are drawn", element("StatsPanel") !== null, true);
  is("and the look editor", element("LookEditor") !== null, true);

  part("A shelf that could not be read: a long catalog, read a page at a time");
  const LONG = "shelf-honest-long@example.com";
  const long = await storeWith(LONG, "shelfhonestlong", 55);
  await shown(LONG);
  const longCalm = await shown(LONG);
  is("control: a page of the products is drawn", [longCalm !== null, (element("ProductEditor")?.props.products as unknown[] | undefined)?.length], [true, 50]);
  const longDown = await shown(LONG, shelfReadOf(long.catalog, long.off[0]));
  is("the page still renders when the page of products cannot be read", longDown !== null, true);
  is("the products' place says they could not be read just now", [has(longDown, SHELF_UNREAD), element("ProductEditor")], [true, null]);

  part("Call products that could not be read");
  const HOST = "shelf-honest-calls@example.com";
  const host = await storeWith(HOST, "shelfhonestcalls", 30);
  const call = await addProduct(HOST, "Coaching call", "", "80", null);
  if (!call.ok) throw new Error("setup: no call product");
  const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
  await setProductCall(HOST, call.product.id, { kind: "weekly", minutes: 60, tz: "America/New_York", weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1, room: "https://example.com/room", video: false, meet: null } as unknown as CallSetup);
  const callKey = `nl:catalog:${host.catalog}:l:${call.product.id}`;
  await shown(HOST);
  const callsCalm = await shown(HOST);
  is("control: the upcoming calls are there, with no could-not-read notice", [has(callsCalm, "Upcoming calls"), has(callsCalm, CALLS_UNREAD)], [true, false]);
  // Only the reads of the call product's record alone (not the shelf's, which reads it with its extra part).
  const callsDown = await shown(HOST, (command, pipeline) => command.includes(callKey) && !pipeline.some((one) => String(one[1]).includes(":x:")));
  is("the page still renders when the call products cannot be read", callsDown !== null, true);
  is("the calls' place says they could not be read just now", has(callsDown, CALLS_UNREAD), true);
  is("as a status, with how to check again", (status(CALLS_UNREAD) ?? "").includes(RELOAD), true);
  is("never as no calls booked", has(callsDown, "Nothing booked yet."), false);
  is("the products themselves are still drawn", element("ProductEditor") !== null, true);

  part("Numbers not shown: the day's readings used, or a reading that failed");
  const NUMBERS = "shelf-honest-numbers@example.com";
  const numbers = await storeWith(NUMBERS, "shelfhonestnumbers", 30);
  const today = new Date().toISOString().slice(0, 10);
  const copyKey = `nl:reading:stats:${numbers.statsId}`;
  const dayKey = `nl:reading:day:${numbers.statsId}:${today}`;
  await redis.pipeline([["HINCRBY", `nl:cotrouble:${numbers.statsId}`, today, 1], ["HSET", `nl:cotrouble:${numbers.statsId}`, "last", JSON.stringify({ at: Date.now() - 60_000, code: "x", message: "Your account cannot currently make live charges." })]]);
  await shown(NUMBERS);
  const numbersCalm = await shown(NUMBERS);
  is("control: the numbers are drawn, with neither notice", [element("StatsPanel") !== null, has(numbersCalm, READINGS_USED), has(numbersCalm, NUMBERS_UNREAD)], [true, false, false]);

  // The day's readings used, and no reading kept to show.
  await redis.pipeline([["DEL", copyKey], ["SET", dayKey, String(STORE_READINGS_PER_DAY)]]);
  const used = await shown(NUMBERS);
  is("the page still renders when the day's readings are used", used !== null, true);
  is("the day's readings used are said so, never left out with no word", has(used, READINGS_USED), true);
  is("as a status", status(READINGS_USED) !== null, true);
  const back = drawn.find((one) => /^UtcAndLocal\d*$/.test((one.type as { name?: string }).name ?? "") && statuses.length > 0);
  is("with when they come back: the next day's start (readingsBackAt)", Math.abs(Number(back?.props.ms ?? 0) - readingsBackAt()) < 60_000, true);
  is("never in the words of a reading that failed", [has(used, NUMBERS_UNREAD), has(status(READINGS_USED), RELOAD)], [false, false]);
  is("the numbers are not drawn", element("StatsPanel"), null);
  is("buyers who could not pay are still warned of", has(used, TROUBLE_SHOWN), true);

  // A reading that failed (its Redis read did not answer), and no reading kept to show.
  await redis.pipeline([["DEL", copyKey, dayKey]]);
  const failed = await shown(NUMBERS, (command) => command[0] === "HGETALL" && String(command[1]).startsWith(`nl:stats:${numbers.statsId}:`));
  is("the page still renders when the reading of the visits fails", failed !== null, true);
  is("a reading that failed is said so, never left out with no word", has(failed, NUMBERS_UNREAD), true);
  is("as a status, with how to check again", (status(NUMBERS_UNREAD) ?? "").includes(RELOAD), true);
  is("never in the words of the day's readings used", has(failed, READINGS_USED), false);
  is("the numbers are not drawn", element("StatsPanel"), null);
  is("buyers who could not pay are still warned of", has(failed, TROUBLE_SHOWN), true);

  // A reading whose replies were not whole (lib/stats.ts readStats answers null): not read, never no numbers.
  await redis.pipeline([["DEL", copyKey, dayKey]]);
  const garbled = await shown(NUMBERS, () => false, (pipeline, replies) =>
    pipeline.length > 90 && pipeline.every((one) => one[0] === "HGETALL" || one[0] === "PFCOUNT" || one[0] === "HMGET") ? replies.map((reply, i) => (i === 0 ? "garbled" : reply)) : replies,
  );
  is("the page still renders when the visits' replies are not whole", garbled !== null, true);
  is("visits read in part are said so, never left out with no word", has(garbled, NUMBERS_UNREAD), true);
  is("the numbers are not drawn from a part", element("StatsPanel"), null);

  part("No new read for the notices");
  const page = readFileSync("app/studio/page.tsx", "utf8");
  is("the kept visits are no longer read as (kept) => kept, () => null", /keptStats\([^)]*\)\)\.then\(\(kept\) => kept, \(\) => null\)/.test(page), false);
  is("the shelf is never awaited without a way to say it could not be read", /shelf: store \? early\(studioShelf\(store, params\)\) : null/.test(page), false);
  await redis.pipeline([["DEL", copyKey], ["SET", dayKey, String(STORE_READINGS_PER_DAY)]]);
  await shown(NUMBERS);
  is("the day's readings used: what is left of the day is not asked again for the notice", sent.some((pipeline) => pipeline.some((one) => one[0] === "GET" && one[1] === dayKey)), false);

  done();
}

void main();
