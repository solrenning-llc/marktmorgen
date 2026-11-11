/**
 * A browser's lock that could not be read just now is unknown, never "not
 * locked" (rule 24, app/studio/page.tsx; LOW 1 of Claude 1's review of #2945).
 * The real studio page, a real store, a real kept passkey and two-step login
 * off; only the read of this browser's lock (lib/two-step.ts lockedUntil)
 * fails:
 * - the app's code is not offered (the invite needs a browser known not to be
 *   locked);
 * - Two-step login, drawn with the props the page hands it, offers nothing a
 *   lock would refuse (no "Turn on two-step login", no recovery-address
 *   field), and says why in place;
 * - the top of the studio says the lock could not be checked, and never
 *   "Some things are locked until" on a guess;
 * - nothing is written: the passkey is still kept and no lock appears.
 * Controls: with the lock read and none there, the invite and the turn-on are
 * offered and no notice is shown; with the browser really locked, the page
 * says so and offers neither.
 */
import { NextRequest } from "next/server";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { listPasskeys } from "@/lib/passkeys";
import { lockedUntil, openLockedSession } from "@/lib/two-step";
import { claimHandle, ensureStatsId } from "@/lib/store";
import StudioPage from "@/app/studio/page";
import { TwoStepManager } from "@/components/two-step-manager";
import { AppCodeInvite } from "@/components/app-code-invite";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const LOCK_NOTICE = "Whether some things are locked could not be checked just now";
const MANAGER_NOTICE = "This page could not check just now whether this browser got in without its second step";

/** Every element of `type` in the tree, with the page's async parts awaited, and every string drawn. */
async function walk(node: unknown, type: unknown, found: Record<string, unknown>[], text: string[], seen = new Set<unknown>()): Promise<void> {
  if (typeof node === "string") {
    text.push(node);
    return;
  }
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (typeof (node as PromiseLike<unknown>).then === "function") return walk(await node, type, found, text, seen);
  if (Array.isArray(node)) {
    await Promise.all(node.map((child) => walk(child, type, found, text, seen)));
    return;
  }
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    if (node.type === type) found.push(props);
    await Promise.all(Object.values(props).map((value) => walk(value, type, found, text, seen)));
  }
}

async function studioOf(session: string, fault: boolean) {
  const kept = redis.pipeline;
  let faults = 0;
  if (fault)
    redis.pipeline = async (commands) => {
      if (commands.some((c) => c[0] === "MGET" && String(c[1]).startsWith("nl:2fa:locked:"))) {
        faults += 1;
        throw new Error("SYNTHETIC_LOCK_READ_FAULT");
      }
      return kept.call(redis, commands);
    };
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
  try {
    const tree = await StudioPage({ searchParams: Promise.resolve({}) });
    const managers: Record<string, unknown>[] = [];
    const invites: Record<string, unknown>[] = [];
    const text: string[] = [];
    await walk(tree, TwoStepManager, managers, text);
    await walk(tree, AppCodeInvite, invites, [], new Set());
    return { managers, invites: invites.length, text: text.join("\n"), faults };
  } finally {
    redis.pipeline = kept;
    answering(null);
  }
}

function drawn(props: Record<string, unknown>): string {
  try {
    return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, createElement(TwoStepManager as unknown as (p: Record<string, unknown>) => null, props)));
  } catch (error) {
    return `render failed: ${(error as Error).message}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "c3-lock-unread@example.com";
  await claimHandle(OWNER, "c3lockunread", "Lock unread", "");
  await ensureStatsId(OWNER);
  await makePasskey(OWNER, "cred-c3-lock-unread").keep();
  is("setup: the passkey is kept", (await listPasskeys(OWNER)).map((p) => p.id), ["cred-c3-lock-unread"]);
  const session = await openSession(OWNER);
  is("setup: this browser is not locked", await lockedUntil(session), 0);

  part("control: the lock was read, and there is none");
  const read = await studioOf(session, false);
  is("the app's code is offered (a passkey, no app's code, not locked)", read.invites, 1);
  is("Two-step login is drawn", read.managers.length > 0, true);
  is("each is drawn with its turn-on", read.managers.every((p) => drawn(p).includes("Turn on two-step login")), true);
  is("no lock notice at the top or in either manager", [read.text.includes(LOCK_NOTICE), read.managers.some((p) => drawn(p).includes(MANAGER_NOTICE))], [false, false]);

  part("this browser's lock could not be read just now");
  const unread = await studioOf(session, true);
  is("the fault happened on the lock read", unread.faults > 0, true);
  is("the app's code is not offered on a guess that the browser is not locked", unread.invites, 0);
  is("Two-step login is still drawn, as often as when the lock was read", unread.managers.length, read.managers.length);
  for (const [i, props] of unread.managers.entries()) {
    const html = drawn(props);
    is(`manager ${i + 1}: nothing a lock would refuse (no turn-on, no recovery-address field, no Cancel)`, [html.includes("Turn on two-step login"), html.includes('id="two-step-backup"'), html.includes("Cancel"), html.includes("Turn it off")], [false, false, false, false]);
    is(`manager ${i + 1}: says why, in place, and keeps its heading and anchor`, [html.includes(MANAGER_NOTICE), html.includes('id="two-step"'), html.includes(">Two-step login</h3>")], [true, true, true]);
    is(`manager ${i + 1}: never says this browser got in without its second step`, html.includes("You got in without your second step"), false);
  }
  is("the top of the studio says the lock could not be checked", unread.text.includes(LOCK_NOTICE), true);
  is("and never says things are locked on a guess", unread.text.includes("Some things are locked until"), false);
  is("nothing was written: the passkey is still kept", (await listPasskeys(OWNER)).map((p) => p.id), ["cred-c3-lock-unread"]);
  is("nothing was written: this browser is still not locked", await lockedUntil(session), 0);

  part("a turn-off request, drawn while the lock is unknown");
  const resetAt = Date.UTC(2026, 10, 20);
  const pending = drawn({ on: true, codesLeft: 8, reset: resetAt, backup: "", fresh: true, locked: false, lockUnknown: true });
  is("the request and its date are still said", pending.includes("Set to turn off on Friday, November 20"), true);
  is("no Cancel, no new codes and no turn-off are offered on a guess", [pending.includes("Cancel: keep two-step login on"), pending.includes("New recovery codes"), pending.includes("Turn it off")], [false, false, false]);
  is("it says to open the page again to cancel it", pending.includes("open this page again in a moment to cancel it"), true);
  const pendingKnown = drawn({ on: true, codesLeft: 8, reset: resetAt, backup: "", fresh: true, locked: false, lockUnknown: false });
  is("control, lock read as none: Cancel is offered", pendingKnown.includes("Cancel: keep two-step login on"), true);

  part("control: this browser is really locked");
  const lockedSession = await openLockedSession(OWNER, Date.now() + 3 * 86_400_000);
  const locked = await studioOf(lockedSession, false);
  is("the app's code is not offered", locked.invites, 0);
  is("the top of the studio says what is locked, not that the lock is unknown", [locked.text.includes("Some things are locked until"), locked.text.includes(LOCK_NOTICE)], [true, false]);
  is("each manager offers no turn-on, and says why", locked.managers.length > 0 && locked.managers.every((p) => !drawn(p).includes("Turn on two-step login") && drawn(p).includes("You got in without your second step")), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
