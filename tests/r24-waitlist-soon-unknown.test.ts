/**
 * Coming soon, read in its exact shape (CX-123 rule 24, 8 November 2026).
 *
 * Whether a product is coming soon (lib/waitlist.ts: isSoon, soonProducts)
 * decides whether its call can be booked and paid for (the booking page) and
 * whether its waitlist takes an address. A reply Redis gave in a shape these
 * readers cannot read (none, not a list, a list with a hole or a member that
 * is not text, a count that is not 0 or 1, a pipeline that lost its reply)
 * is unknown, never "not coming soon":
 *
 *   - the readers throw, so no caller can take unknown for "launched";
 *   - joining a waitlist then sends nothing and never says the list is closed
 *     (its route answers "error");
 *   - the studio's view of a waitlist is not drawn from an unread set;
 *   - the booking page books and sells nothing on an unknown state and says
 *     the times could not be read, with no `.catch(() => false)` left on any
 *     caller.
 *
 * Healthy and confirmed-empty readings read exactly as before.
 * Synthetic store; one reply injected at a time; no network.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { isSoon, joinWaitlist, setSoon, soonProducts, waitlistViews } from "@/lib/waitlist";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** One command's reply replaced; `lost` answers the whole pipeline with no reply at all. */
let inject: { command: string; reply: unknown; lost?: unknown } | null = null;
let hits = 0;
redis.pipeline = (async (batch: Command[]) => {
  if (inject && batch.some((c) => c[0] === inject!.command)) {
    hits += 1;
    if ("lost" in inject) return inject.lost;
    const answers = await real(batch);
    return batch.map((c, i) => (c[0] === inject!.command ? inject!.reply : answers[i]));
  }
  return real(batch);
}) as typeof redis.pipeline;

let mails = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    mails += 1;
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const outcome = (work: () => Promise<unknown>) =>
  work().then(
    (value) => JSON.stringify(value instanceof Set ? [...value].sort() : value),
    () => "unknown",
  );

const holey = [, "p1"];
const ODD_MEMBERS: [string, unknown][] = [
  ["no reply (null)", null],
  ["not a list (a string)", "p1"],
  ["not a list (a number)", 7],
  ["not a list (an object)", { 0: "p1", length: 1 }],
  ["a list with a hole", holey],
  ["a list with a member that is not text", ["p1", 7]],
  ["a list with a list in it", [["p1"]]],
];
const ODD_FLAG: [string, unknown][] = [
  ["no reply (null)", null],
  ["a word", "yes"],
  ["a count that is not 0 or 1", 2],
  ["a negative count", -1],
  ["a list", ["p1"]],
  ["true", true],
];
const LOST: [string, unknown][] = [
  ["a pipeline with no replies", []],
  ["a pipeline answered null", null],
  ["a pipeline with a hole", holey.slice(0, 1)],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  const owner = "r24-soon@example.com";
  await claimHandle(owner, "r24soon", "R24 Soon", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const made = await addProduct(owner, "The Soon Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;

  part("Controls: healthy and confirmed-empty readings read as before");
  is("absent: not coming soon", [await outcome(() => isSoon(store, product.id)), await outcome(() => soonProducts(store))], ["false", "[]"]);
  await setSoon(store, product.id, true);
  is("marked: coming soon", [await outcome(() => isSoon(store, product.id)), await outcome(() => soonProducts(store))], ["true", JSON.stringify([product.id])]);
  is("the waitlist takes an address", await joinWaitlist({ store, product, email: "dana@example.com", consent: false, ip: "1.1.1.1", origin: "https://marktmorgen.com" }), "sent");
  is("the studio sees it coming soon", (await waitlistViews(store, [product.id]))[product.id]?.soon, true);
  await setSoon(store, product.id, false);
  is("unmarked: not coming soon again", [await outcome(() => isSoon(store, product.id)), await outcome(() => soonProducts(store))], ["false", "[]"]);
  inject = { command: "SISMEMBER", reply: "0" };
  is("a text 0 is still a no, as lib/preorders.ts reads it", await outcome(() => isSoon(store, product.id)), "false");
  inject = { command: "SISMEMBER", reply: "1" };
  is("a text 1 is still a yes", await outcome(() => isSoon(store, product.id)), "true");
  inject = { command: "SMEMBERS", reply: [] };
  is("an empty list is a confirmed empty set", await outcome(() => soonProducts(store)), "[]");
  inject = null;

  part("isSoon: a reply out of shape is unknown, never 'launched'");
  for (const [label, reply] of ODD_FLAG) {
    inject = { command: "SISMEMBER", reply };
    hits = 0;
    const got = await outcome(() => isSoon(store, product.id));
    is(`${label}: the reply was read`, hits > 0, true);
    is(`${label}: unknown, never false`, got, "unknown");
  }
  for (const [label, lost] of LOST) {
    inject = { command: "SISMEMBER", reply: null, lost };
    is(`${label}: unknown, never false`, await outcome(() => isSoon(store, product.id)), "unknown");
  }
  inject = null;

  part("soonProducts: a reply out of shape is unknown, never an empty set");
  for (const [label, reply] of ODD_MEMBERS) {
    inject = { command: "SMEMBERS", reply };
    hits = 0;
    const got = await outcome(() => soonProducts(store));
    is(`${label}: the reply was read`, hits > 0, true);
    is(`${label}: unknown, never an empty set`, got, "unknown");
  }
  for (const [label, lost] of LOST) {
    inject = { command: "SMEMBERS", reply: null, lost };
    is(`${label}: unknown, never an empty set`, await outcome(() => soonProducts(store)), "unknown");
  }
  inject = null;

  part("Joining: unknown sends nothing and never says the list is closed");
  await setSoon(store, product.id, true);
  for (const [label, reply] of [...ODD_FLAG.slice(0, 3), ["lost", null]] as [string, unknown][]) {
    inject = label === "lost" ? { command: "SISMEMBER", reply: null, lost: [] } : { command: "SISMEMBER", reply };
    mails = 0;
    const got = await outcome(() => joinWaitlist({ store, product, email: "hal@example.com", consent: false, ip: "2.2.2.2", origin: "https://marktmorgen.com" }));
    is(`${label}: not "closed", not "sent" (the route answers "error")`, got, "unknown");
    is(`${label}: no email`, mails, 0);
  }
  inject = null;

  part("The studio's view: never drawn from an unread set");
  for (const [label, reply] of ODD_MEMBERS.slice(0, 2)) {
    inject = { command: "SMEMBERS", reply };
    is(`${label}: the view is unknown, never "not coming soon"`, await outcome(() => waitlistViews(store, [product.id])), "unknown");
  }
  inject = null;

  part("The booking page: unknown books and sells nothing and says so");
  const page = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
  is("no caller reads an unknown coming-soon state as launched", /isSoon\([^)]*\)\.catch\(\(\) => false\)/.test(page), false);
  is("the calendar opens only on a confirmed no", page.includes("const open = sellable && soon === false;"), true);
  is("an unknown state is told apart from a closed calendar", page.includes("const unread = sellable && soon === null;"), true);
  is("an unknown state draws the times-unread notice, not 'unavailable', and no times", page.includes("{!open && !unread ? ("), true);
  is("the times are read only while open", page.includes("const read = open ? await slotsForProduct("), true);
  is("the package offer only while open", page.includes(") : open && product.callPackage ? ("), true);

  part("Every caller: no lenient default left in app, lib or components");
  const callers = execFileSync("git", ["grep", "-n", "-E", "\\b(isSoon|soonProducts)\\(", "--", "app", "lib", "components"], { encoding: "utf8" }).trim().split("\n");
  is("the callers found (two readers, one join, one view, one page)", callers.length >= 5, true);
  const lenient = callers.filter((line) => /\.catch\(\(\) => (false|new Set|\[\]|\(\{\}\)|\{\})/.test(line));
  is("none defaults to false or an empty set", lenient, []);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
