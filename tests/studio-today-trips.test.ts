/**
 * 651 [WG11], unit 2 (C4-20261106-2710-C6-159): Today, the studio's home (app/studio/page.tsx), waits for Redis in
 * as few steps one after another as it can, with no more trips in all.
 *
 * Measured with the real page and a real store; only Redis is slowed, by 40 ms a trip, as a real network would be.
 * A "step" is a trip that starts while no other trip is under way: a page that waits for one read before the next
 * takes one step for each, and reads sent together take one step for all of them. On main before this unit Today
 * took 42 steps and 65 trips for this store, about 1.7 s at 40 ms a trip (local measurement on an emulated slow
 * network: TTFB 2.18 s).
 *
 * Step 1 of the unit sends the page's own loading together (42 to 19 steps, 1.75 s to about 0.97 s, the same 65
 * trips). The remaining steps were awaits inside the page's JSX, each read only when its section is shown, one after
 * another; step 2 makes each such section its own part, rendered beside the others, so they wait together.
 *
 * The page is measured as React renders it: the tree it returns is walked, every promise in it is waited for and
 * every async component in it is run, siblings together, the way React renders a server tree. Calling the page alone
 * would not wait for those parts.
 *
 * What fails here:
 *   - more than 12 steps one after another at 40 ms a trip (the time is printed, not checked: a clock on a busy
 *     machine measures the machine, while the steps are counted from the order of the trips);
 *   - more than 66 trips in all: each trip is a request to Upstash, so more of them is more cost per visit (MR). The
 *     whole tree takes one trip more than the page alone, the reminder's own read (components/path-studio-reminder.tsx),
 *     which was always there: 66 on step 1, rendered whole;
 *   - a page that no longer loads for its owner (a redirect or a throw).
 */
import { isValidElement } from "react";
import { NextRequest } from "next/server";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import StudioPage from "@/app/studio/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DELAY_MS = 40;
const MAX_STEPS = 12;
const MAX_TRIPS = 66;

/**
 * Renders the tree a server component returned, as React does on the server: a promise is waited for, an async
 * component is run with its props, and the children and element props of everything else are rendered, siblings
 * together. A part that throws makes the whole render throw, as it fails the page.
 */
async function render(node: unknown): Promise<void> {
  if (node === null || typeof node !== "object") return;
  if (typeof (node as PromiseLike<unknown>).then === "function") return render(await node);
  if (Array.isArray(node)) {
    await Promise.all(node.map(render));
    return;
  }
  if (!isValidElement(node)) return;
  const { type, props } = node as { type: unknown; props: Record<string, unknown> };
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return render(await (type as (p: unknown) => Promise<unknown>)(props));
  await Promise.all(Object.values(props).map(render));
}

const open = async (): Promise<void> => render(await StudioPage({ searchParams: Promise.resolve({}) }));

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "today-trips@example.com";
  await claimHandle(OWNER, "todaytrips", "Today trips", "");
  await ensureStatsId(OWNER);
  await addProduct(OWNER, "Guide", "", "19", null);
  const session = await openSession(OWNER);
  const request = () => new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } });

  // Once without delay, so what a first opening writes (a store's counter, its folders) is already there.
  answering(request());
  await open();

  const original = redis.pipeline.bind(redis);
  let trips = 0;
  let steps = 0;
  let inFlight = 0;
  redis.pipeline = async (commands) => {
    trips += 1;
    if (inFlight === 0) steps += 1;
    inFlight += 1;
    try {
      await new Promise((wait) => setTimeout(wait, DELAY_MS));
      return await original(commands);
    } finally {
      inFlight -= 1;
    }
  };
  let loaded = true;
  const started = Date.now();
  try {
    answering(request());
    await open();
  } catch (error) {
    loaded = false;
    console.error(error);
  } finally {
    redis.pipeline = original;
    answering(null);
  }
  const ms = Date.now() - started;
  console.log("TODAY_TRIPS:" + JSON.stringify({ trips, steps, ms }));

  part(`Today at ${DELAY_MS} ms a Redis trip`);
  is("the page loads for its owner", loaded, true);
  is(`at most ${MAX_STEPS} steps one after another`, steps <= MAX_STEPS, true);
  is(`no more than ${MAX_TRIPS} trips in all`, trips <= MAX_TRIPS, true);

  // Codex M on #2900: with the store's cached titles gone (a cold or old cache), the parts that read the cards side by
  // side must not each repair it. Read in order, the page repaired it once.
  part("Today with the store's cached titles gone");
  const catalog = (await storeForEmail(OWNER))?.catalog.id;
  if (!catalog) throw new Error("setup: catalog");
  const titles = `nl:catalog:${catalog}:t`;
  await original([["DEL", titles]]);
  let repairs = 0;
  redis.pipeline = async (commands) => {
    if (commands.some((command) => command[0] === "HSET" && command[1] === titles)) repairs += 1;
    return original(commands);
  };
  try {
    answering(request());
    await open();
  } finally {
    redis.pipeline = original;
    answering(null);
  }
  is("the titles are repaired once", repairs, 1);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
