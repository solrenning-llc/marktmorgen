/**
 * 651 [WG11] unit 2, on Today (app/studio/page.tsx): the person's passkeys, and whether this session may add or keep
 * one, are read only after the passkeys whose wait has run out are removed (lib/passkeys.ts pendingRemoval), as before
 * the page sent its reads together. Read beside that removal, the list still held the passkey being removed, and the
 * studio showed a passkey that could no longer log in, with no removal date beside it.
 *
 * The real page, a real store and a real passkey set to be removed seven days and a minute ago (its removal record
 * written as lib/passkeys.ts writes one whose notice went out). What Today hands its passkey managers must not hold that passkey.
 *
 * And the banner over Today about two-step login (Claude 4's C4-2980 on #2900): when the person's two-step login could
 * not be read, the page says so plainly, rather than reading it as "no request to turn it off" and showing nothing.
 * Nor does Two-step login below, or the invitation to add an app's code, take that unread login for "off": they offer
 * no way to turn it on over it, and say it could not be read (CX-123 rule 24, lib/redis-reply.ts).
 *
 * And "Update now" (Claude 5's LEVE 1 on #2835): the day's reading of the store's numbers is taken only once the
 * reads the page waits for have answered, never for a page that ends in its error.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { REMOVAL_DAYS, listPasskeys } from "@/lib/passkeys";
import { addProduct, claimHandle, ensureStatsId } from "@/lib/store";
import StudioPage from "@/app/studio/page";
import { AppCodeInvite } from "@/components/app-code-invite";
import { TwoStepManager } from "@/components/two-step-manager";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** Every string shown anywhere in the page's tree. */
function words(node: unknown, found: string[] = [], seen = new Set<unknown>()): string[] {
  if (typeof node === "string") {
    found.push(node);
    return found;
  }
  if (!node || typeof node !== "object" || seen.has(node)) return found;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) words(child, found, seen);
    return found;
  }
  if (isValidElement(node)) words((node.props as { children?: unknown }).children, found, seen);
  return found;
}

/** Every list of passkeys handed to a component anywhere in the page's tree (the managers' `initial`). */
function passkeyLists(node: unknown, found: string[][] = [], seen = new Set<unknown>()): string[][] {
  if (!node || typeof node !== "object" || seen.has(node)) return found;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) passkeyLists(child, found, seen);
    return found;
  }
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    const initial = props.initial;
    if (Array.isArray(initial) && initial.every((p) => p && typeof p === "object" && "synced" in p && "id" in p)) found.push(initial.map((p) => String((p as { id: string }).id)));
    for (const value of Object.values(props)) passkeyLists(value as ReactNode, found, seen);
  }
  return found;
}

/** The props of every element of one component anywhere in the page's tree. */
function propsOf(node: unknown, type: unknown, found: Record<string, unknown>[] = [], seen = new Set<unknown>()): Record<string, unknown>[] {
  if (!node || typeof node !== "object" || seen.has(node)) return found;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, type, found, seen);
    return found;
  }
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    if (node.type === type) found.push(props);
    for (const value of Object.values(props)) propsOf(value as ReactNode, type, found, seen);
  }
  return found;
}

/** What each Two-step login on the page shows, drawn as the browser first gets it. */
function twoStepShown(tree: unknown): string[] {
  return propsOf(tree, TwoStepManager).map((props) => renderToStaticMarkup(createElement(TwoStepManager, props as Parameters<typeof TwoStepManager>[0])));
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "today-removal@example.com";
  await claimHandle(OWNER, "todayremoval", "Today removal", "");
  await ensureStatsId(OWNER);
  await makePasskey(OWNER, "cred-today-due").keep();
  await makePasskey(OWNER, "cred-today-kept").keep();
  // Set to go seven days and a minute ago, its notice delivered then (lib/passkeys.ts writeDrop): its wait is over.
  const asked = Date.now() - REMOVAL_DAYS * 86_400_000 - 60_000;
  await redis.pipeline([["SET", `nl:pk:drop:${hex(`nimbus-passkey-drop:${OWNER}`).slice(0, 40)}`, JSON.stringify({ atOf: { "cred-today-due": asked + REMOVAL_DAYS * 86_400_000 }, told: asked })]]);
  const session = await openSession(OWNER);

  part("Today, with a passkey whose wait has run out");
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
  let tree: unknown = null;
  try {
    tree = await StudioPage({ searchParams: Promise.resolve({}) });
  } finally {
    answering(null);
  }
  const lists = passkeyLists(tree);
  is("the page hands its passkey managers a list", lists.length > 0, true);
  is("the passkey that was removed is in none of them", lists.map((ids) => ids.includes("cred-today-due")), lists.map(() => false));
  is("the other passkey is in each", lists.map((ids) => ids.includes("cred-today-kept")), lists.map(() => true));
  is("and the removal was applied", (await listPasskeys(OWNER)).map((p) => p.id), ["cred-today-kept"]);

  // Codex M's case on #2835 (review 5806799980): the page's own removal read fails once before it runs, so the
  // removal is applied by the second-step checks instead; the list is still read only after them.
  part("Today, when the page's first removal read fails once");
  const SECOND = "today-removal-fault@example.com";
  await claimHandle(SECOND, "todayremovalfault", "Today removal fault", "");
  await ensureStatsId(SECOND);
  await makePasskey(SECOND, "cred-fault-due").keep();
  await makePasskey(SECOND, "cred-fault-kept").keep();
  const dropKey = `nl:pk:drop:${hex(`nimbus-passkey-drop:${SECOND}`).slice(0, 40)}`;
  await redis.pipeline([["SET", dropKey, JSON.stringify({ atOf: { "cred-fault-due": asked + REMOVAL_DAYS * 86_400_000 }, told: asked })]]);
  const secondSession = await openSession(SECOND);
  const original = redis.pipeline;
  let faulted = false;
  redis.pipeline = async (commands) => {
    if (!faulted && commands.length === 1 && commands[0]?.[0] === "GET" && commands[0]?.[1] === dropKey) {
      faulted = true;
      throw new Error("SYNTHETIC_DROP_READ_FAULT");
    }
    return original.call(redis, commands);
  };
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${secondSession}` } }));
  let faultTree: unknown = null;
  try {
    faultTree = await StudioPage({ searchParams: Promise.resolve({}) });
  } finally {
    redis.pipeline = original;
    answering(null);
  }
  const faultLists = passkeyLists(faultTree);
  is("the fault happened once, on the removal's first read", faulted, true);
  is("the page still hands its passkey managers a list", faultLists.length > 0, true);
  is("the removed passkey is in none of them", faultLists.map((ids) => ids.includes("cred-fault-due")), faultLists.map(() => false));
  is("and the removal was applied by the second-step checks", (await listPasskeys(SECOND)).map((p) => p.id), ["cred-fault-kept"]);

  // Two-step login on, with a request to turn it off without a code waiting three days (lib/two-step.ts askReset).
  const THIRD = "today-two-step@example.com";
  await claimHandle(THIRD, "todaytwostep", "Today two-step", "");
  await ensureStatsId(THIRD);
  // A passkey too, so the page would invite them to add an app's code if it took their two-step login for "off".
  await makePasskey(THIRD, "cred-today-two-step").keep();
  const recordKey = `nl:2fa:${hex(`nimbus-2fa:${THIRD}`).slice(0, 40)}`;
  const reset = Date.now() + 3 * 86_400_000;
  await redis.pipeline([["SET", recordKey, JSON.stringify({ s: "synthetic-secret", since: Date.now() - 86_400_000, codes: [], last: -1, reset, backup: "" })]]);
  const thirdSession = await openSession(THIRD);
  const render = async (fault: boolean): Promise<unknown> => {
    const kept = redis.pipeline;
    if (fault)
      redis.pipeline = async (commands) => {
        if (commands.some((c) => c[0] === "GET" && c[1] === recordKey)) throw new Error("SYNTHETIC_TWO_STEP_READ_FAULT");
        return kept.call(redis, commands);
      };
    answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${thirdSession}` } }));
    try {
      return await StudioPage({ searchParams: Promise.resolve({}) });
    } finally {
      redis.pipeline = kept;
      answering(null);
    }
  };
  part("Today, with a request to turn two-step login off, read");
  const readTree = await render(false);
  const read = words(readTree).join(" ");
  is("the warning says two-step login is set to turn off", read.includes("Two-step login is set to turn off"), true);
  is("and does not say it could not be read", read.includes("Two-step login could not be read just now"), false);

  part("Today, when the person's two-step login cannot be read");
  const unreadTree = await render(true);
  const unread = words(unreadTree).join(" ");
  is("the page says plainly it could not be read", unread.includes("Two-step login could not be read just now"), true);
  is("and that a request to turn it off may be waiting", unread.includes("cannot tell whether somebody asked to turn your two-step login off"), true);
  is("the warning is not shown as fact", unread.includes("Two-step login is set to turn off"), false);
  is("and it names Cancel only for once the request shows", unread.includes("Once it shows, if a request is waiting and it was not you, press Cancel"), true);
  is("the request is still there", JSON.parse(String((await redis.pipeline([["GET", recordKey]]))[0])).reset, reset);

  part("Two-step login below, read");
  const readShown = twoStepShown(readTree);
  is("the page shows Two-step login", readShown.length > 0, true);
  is("it says two-step login is on", readShown.map((html) => html.includes("On. Logging in with the emailed link also asks")), readShown.map(() => true));
  is("and offers to cancel the request", readShown.map((html) => html.includes("Cancel: keep two-step login on")), readShown.map(() => true));
  is("no invitation to add an app's code: it is on", propsOf(readTree, AppCodeInvite).length, 0);

  part("Two-step login below, when it cannot be read");
  const unreadShown = twoStepShown(unreadTree);
  is("the page still shows Two-step login", unreadShown.length > 0, true);
  is("where the banner's link goes", unreadShown.map((html) => html.includes('id="two-step"')), unreadShown.map(() => true));
  is("it says it could not be read", unreadShown.map((html) => html.includes("Two-step login could not be read just now")), unreadShown.map(() => true));
  is("it is not said to be off", unreadShown.map((html) => html.includes("After the emailed link, ask for a six-digit code")), unreadShown.map(() => false));
  is("it offers no way to turn it on over it", unreadShown.map((html) => html.includes("Turn on two-step login")), unreadShown.map(() => false));
  is("nor asks to log in again to turn it on", unreadShown.map((html) => html.includes("Turning this on needs a login")), unreadShown.map(() => false));
  is("nor any other button or form, on a state it does not know", unreadShown.map((html) => /<button|<form/.test(html)), unreadShown.map(() => false));
  is("no invitation to add an app's code", propsOf(unreadTree, AppCodeInvite).length, 0);
  is("and the record is untouched", JSON.parse(String((await redis.pipeline([["GET", recordKey]]))[0])).s, "synthetic-secret");

  // Claude 5's LEVE 1 on #2835: "Update now" (numbers=fresh) reads the store's numbers again from the day's own
  // budget (lib/store-readings.ts takeStoreReading). Sent together with the other reads, that reading was taken
  // even when a read the page waits for failed and the page ended in its error; it waits for them now.
  const freshPage = async (owner: string, fault: boolean): Promise<{ loaded: boolean; spent: number }> => {
    await claimHandle(owner, owner.split("@")[0].replace(/[^a-z]/g, ""), "Today fresh", "");
    await ensureStatsId(owner);
    await addProduct(owner, "Guide", "", "19", null);
    const ownerSession = await openSession(owner);
    const kept = redis.pipeline;
    let spent = 0;
    redis.pipeline = async (commands) => {
      if (commands.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:reading:day:"))) spent += 1;
      if (fault && commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:catalog:"))) throw new Error("SYNTHETIC_PRODUCTS_READ_FAULT");
      return kept.call(redis, commands);
    };
    answering(new NextRequest("https://marktmorgen.com/studio?numbers=fresh", { headers: { cookie: `${SESSION_COOKIE}=${ownerSession}` } }));
    let loaded = true;
    try {
      await StudioPage({ searchParams: Promise.resolve({ numbers: "fresh" }) });
    } catch {
      loaded = false;
    } finally {
      redis.pipeline = kept;
      answering(null);
    }
    return { loaded, spent };
  };
  part("Update now, when a read the page waits for fails");
  const failing = await freshPage("todayfreshfault@example.com", true);
  is("the page ends in its error (precondition)", failing.loaded, false);
  is("the day's reading is not taken for it", failing.spent, 0);
  part("Update now, when every read answers");
  const healthy = await freshPage("todayfreshok@example.com", false);
  is("the page loads", healthy.loaded, true);
  is("and the numbers are read again, from the day's budget", healthy.spent, 1);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
