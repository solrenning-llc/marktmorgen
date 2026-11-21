/**
 * #2862, LEVE of Claude 4's focal return at ca8fb676: when a store's list size cannot be read (an unclear Redis reply,
 * lib/free.ts listSize), Today says "We could not count your list just now" and still shows the store's visits and
 * sales.
 *
 * Today (app/studio/page.tsx) starts the list size early and asks for the kept readings (lib/store-readings.ts) only
 * once every read it waits for has answered (`answered`). The catch that turns a failed list size into "unread" sat
 * only on the page's later await, so the early read itself still rejected, `answered` rejected with it, and the
 * visits and sales were never asked for: they vanished from the page although nothing kept them from being read.
 *
 * Measured with the real page and a real store; only the reply to the list's HLEN is changed, to a shape that is not
 * a count. What fails here: the stats reading not asked for, or the "unread" card not drawn, or the page not loading.
 */

import { isValidElement } from "react";
import { NextRequest } from "next/server";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import StudioPage from "@/app/studio/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** Renders the tree as React does on the server (tests/studio-today-trips.test.ts), keeping every text it meets. */
async function render(node: unknown, texts: string[]): Promise<void> {
  if (typeof node === "string") {
    texts.push(node);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (typeof (node as PromiseLike<unknown>).then === "function") return render(await node, texts);
  if (Array.isArray(node)) {
    await Promise.all(node.map((child) => render(child, texts)));
    return;
  }
  if (!isValidElement(node)) return;
  const { type, props } = node as { type: unknown; props: Record<string, unknown> };
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return render(await (type as (p: unknown) => Promise<unknown>)(props), texts);
  await Promise.all(Object.values(props).map((value) => render(value, texts)));
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "list-unread-stats@example.com";
  await claimHandle(OWNER, "listunreadstats", "List unread stats", "");
  await ensureStatsId(OWNER);
  const shop = await storeForEmail(OWNER);
  if (!shop?.listId || !shop.statsId) throw new Error("setup: the store has no list or no counter");
  const leads = `nl:store:leads:${shop.listId}`;
  const statsCopy = `nl:reading:stats:${shop.statsId}`;
  const session = await openSession(OWNER);
  const request = () => new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } });

  const original = redis.pipeline.bind(redis);
  const open = async (oddListSize: boolean) => {
    let statsAsked = false;
    let listAsked = false;
    redis.pipeline = async (commands) => {
      if (commands.some((command) => command[0] === "GET" && command[1] === statsCopy)) statsAsked = true;
      const replies = await original(commands);
      const at = commands.findIndex((command) => command[0] === "HLEN" && command[1] === leads);
      if (at < 0) return replies;
      listAsked = true;
      if (!oddListSize) return replies;
      const changed = [...(replies as unknown[])];
      changed[at] = { count: "not a count" };
      return changed as typeof replies;
    };
    const texts: string[] = [];
    let loaded = true;
    try {
      answering(request());
      await render(await StudioPage({ searchParams: Promise.resolve({}) }), texts);
    } catch (error) {
      loaded = false;
      console.error(error);
    } finally {
      redis.pipeline = original;
      answering(null);
    }
    return { loaded, statsAsked, listAsked, unread: texts.join(" ").includes("We could not count your list just now") };
  };

  // Once plainly first, so what a first opening writes is already there.
  await open(false);

  part("Control: the list size read plainly");
  const plain = await open(false);
  is("the page loads for its owner", plain.loaded, true);
  is("the list size is read", plain.listAsked, true);
  is("the stats reading is asked for", plain.statsAsked, true);
  is("no unread card", plain.unread, false);

  part("The list size in another shape: unread, and the visits and sales still read");
  const odd = await open(true);
  is("the page loads for its owner", odd.loaded, true);
  is("the list size is read", odd.listAsked, true);
  is("the unread card is drawn", odd.unread, true);
  is("the stats reading is still asked for", odd.statsAsked, true);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
