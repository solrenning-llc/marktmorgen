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
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { isValidElement, type ReactNode } from "react";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { REMOVAL_DAYS, listPasskeys } from "@/lib/passkeys";
import { claimHandle, ensureStatsId } from "@/lib/store";
import StudioPage from "@/app/studio/page";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** Every string shown anywhere in the page's tree, its parts waited for as passkeyLists waits for them. */
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

/**
 * Every list of passkeys handed to a component anywhere in the page's tree (the managers' `initial`). The page's
 * parts are promises rendered beside each other (WG11 unit 2, step 2): each is waited for, inside the request, as
 * React waits for them.
 */
async function passkeyLists(node: unknown, found: string[][] = [], seen = new Set<unknown>()): Promise<string[][]> {
  if (!node || typeof node !== "object" || seen.has(node)) return found;
  seen.add(node);
  if (typeof (node as PromiseLike<unknown>).then === "function") return passkeyLists(await node, found, seen);
  if (Array.isArray(node)) {
    await Promise.all(node.map((child) => passkeyLists(child, found, seen)));
    return found;
  }
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    const initial = props.initial;
    if (Array.isArray(initial) && initial.every((p) => p && typeof p === "object" && "synced" in p && "id" in p)) found.push(initial.map((p) => String((p as { id: string }).id)));
    await Promise.all(Object.values(props).map((value) => passkeyLists(value as ReactNode, found, seen)));
  }
  return found;
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
  let lists: string[][] = [];
  try {
    lists = await passkeyLists(await StudioPage({ searchParams: Promise.resolve({}) }));
  } finally {
    answering(null);
  }
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
  let faultLists: string[][] = [];
  try {
    faultLists = await passkeyLists(await StudioPage({ searchParams: Promise.resolve({}) }));
  } finally {
    redis.pipeline = original;
    answering(null);
  }
  is("the fault happened once, on the removal's first read", faulted, true);
  is("the page still hands its passkey managers a list", faultLists.length > 0, true);
  is("the removed passkey is in none of them", faultLists.map((ids) => ids.includes("cred-fault-due")), faultLists.map(() => false));
  is("and the removal was applied by the second-step checks", (await listPasskeys(SECOND)).map((p) => p.id), ["cred-fault-kept"]);

  // Two-step login on, with a request to turn it off without a code waiting three days (lib/two-step.ts askReset).
  const THIRD = "today-two-step@example.com";
  await claimHandle(THIRD, "todaytwostep", "Today two-step", "");
  await ensureStatsId(THIRD);
  const recordKey = `nl:2fa:${hex(`nimbus-2fa:${THIRD}`).slice(0, 40)}`;
  const reset = Date.now() + 3 * 86_400_000;
  await redis.pipeline([["SET", recordKey, JSON.stringify({ s: "synthetic-secret", since: Date.now() - 86_400_000, codes: [], last: -1, reset, backup: "" })]]);
  const thirdSession = await openSession(THIRD);
  const render = async (fault: boolean): Promise<string> => {
    const kept = redis.pipeline;
    if (fault)
      redis.pipeline = async (commands) => {
        if (commands.some((c) => c[0] === "GET" && c[1] === recordKey)) throw new Error("SYNTHETIC_TWO_STEP_READ_FAULT");
        return kept.call(redis, commands);
      };
    answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${thirdSession}` } }));
    try {
      return (await words(await StudioPage({ searchParams: Promise.resolve({}) }))).join(" ");
    } finally {
      redis.pipeline = kept;
      answering(null);
    }
  };
  part("Today, with a request to turn two-step login off, read");
  const read = await render(false);
  is("the warning says two-step login is set to turn off", read.includes("Two-step login is set to turn off"), true);
  is("and does not say it could not be read", read.includes("Two-step login could not be read just now"), false);

  part("Today, when the person's two-step login cannot be read");
  const unread = await render(true);
  is("the page says plainly it could not be read", unread.includes("Two-step login could not be read just now"), true);
  is("and that a request to turn it off may be waiting", unread.includes("cannot tell whether somebody asked to turn your two-step login off"), true);
  is("the warning is not shown as fact", unread.includes("Two-step login is set to turn off"), false);
  is("the request is still there", JSON.parse(String((await redis.pipeline([["GET", recordKey]]))[0])).reset, reset);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
