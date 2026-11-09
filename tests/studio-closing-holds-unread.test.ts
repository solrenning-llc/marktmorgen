/**
 * Today, for a store whose plan ended and that closes whole on its day (app/studio/page.tsx): the notice that some
 * memberships' payments are not paused yet reads the hold's counts (lib/closing-holds.ts holdCounts). Since those
 * counts throw UnknownReplyError when they cannot be read (CX-123 rules 24 and 30,
 * tests/closing-reads-siblings.test.ts), the page caught the throw as "nothing to say" (`.catch(() => null)`) and
 * showed no notice at all: the creator was not told that a member may still be charged before the closing day.
 *
 * Now the page says plainly, in a status notice, that this could not be read just now, and what to do if a member is
 * charged, and never gives a count of memberships it did not read. Read, the counts show as before.
 *
 * The real page, a real store and its real hold record; only the hold's HKEYS is made to fail. Synthetic data only.
 */
import { NextRequest } from "next/server";
import { isValidElement } from "react";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { workKey } from "@/lib/closing-holds";
import StudioPage from "@/app/studio/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const EMAIL = "closing-holds-unread@example.com";
const UNREAD = "Whether every membership's payments are paused could not be read just now";

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
  if (isValidElement(node)) await words((node.props as { children?: unknown }).children, found, seen);
  return found;
}

/** The props of every element whose text holds `text`, so the notice's role can be read. */
async function holderOf(node: unknown, text: string, seen = new Set<unknown>()): Promise<Record<string, unknown> | null> {
  if (!node || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (typeof (node as PromiseLike<unknown>).then === "function") return holderOf(await node, text, seen);
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = await holderOf(child, text, seen);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  const children = props.children;
  const own = (Array.isArray(children) ? children : [children]).some((c) => typeof c === "string" && c.includes(text));
  if (own) return props;
  return holderOf(children, text, seen);
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(EMAIL, "closingholdsunread", "Closing holds unread", "");
  await setSubscription(EMAIL, { customerId: "cus_ClosingUnread01", subscriptionId: "sub_ClosingUnread01", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  // The plan ends now: a plan ended from 18 October 2026 closes the whole store on its day (lib/plan-closing-rules.ts).
  await setSubscription(EMAIL, { active: false });
  const store = (await storeForEmail(EMAIL))!;
  const folder = await storeFolder(storeRef(store));
  // One membership the hold could not pause yet, as lib/closing-holds.ts writes it.
  await redis.pipeline([["HSET", workKey(folder), "f:sub_MemberNotPaused01", "1"]]);
  const session = await openSession(EMAIL);

  const render = async (fault: boolean): Promise<{ text: string; tree: unknown }> => {
    const kept = redis.pipeline;
    if (fault)
      redis.pipeline = async (commands) => {
        if (commands.some((c) => c[0] === "HKEYS" && c[1] === workKey(folder))) throw new Error("SYNTHETIC_HOLD_COUNTS_FAULT");
        return kept.call(redis, commands);
      };
    answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
    try {
      const tree = await StudioPage({ searchParams: Promise.resolve({}) });
      return { text: (await words(tree)).join(" "), tree };
    } finally {
      redis.pipeline = kept;
      answering(null);
    }
  };

  part("Today, the hold's counts read");
  const read = await render(false);
  is("the page is the closing store's", read.text.includes("Your plan has ended, and your store closes on"), true);
  is("one membership not paused yet, counted", read.text.includes("1 membership's payments are not paused yet: we try again every day"), true);
  is("and it does not say the counts could not be read", read.text.includes(UNREAD), false);

  part("Today, when the hold's counts cannot be read");
  const unread = await render(true);
  is("the page is still the closing store's", unread.text.includes("Your plan has ended, and your store closes on"), true);
  is("it says plainly the counts could not be read just now", unread.text.includes(UNREAD), true);
  is("it says what to do if a member is charged", unread.text.includes("If a member is charged before then, please refund them from Stripe."), true);
  is("and to look again", unread.text.includes("Open this page again in a moment to see."), true);
  is("no count it did not read", [/\d+ membership's payments are not paused/.test(unread.text), /\d+ memberships' payments are not paused/.test(unread.text)], [false, false]);
  const holder = await holderOf(unread.tree, UNREAD);
  is("the notice is a status, read out by a screen reader", holder?.role ?? null, "status");
  is("the hold's record is untouched", (await redis.pipeline([["HKEYS", workKey(folder)]]))[0], ["f:sub_MemberNotPaused01"]);

  done();
}

void main();
