/**
 * A passkey list that could not be read just now is unknown, never "no
 * passkeys" (rule 24, app/studio/page.tsx; Claude 3's review of #2945).
 * The real studio page, a real store and a real kept passkey, with no recovery
 * address; only the read of the passkey list fails:
 * - the "Keep a way back in" step is not listed as not done over a passkey
 *   that is kept, nor left out as if setup were complete: it is listed as
 *   "could not be checked just now", in the steps and in the saved checklist,
 *   so "Getting your store ready" never looks complete over it (LOW 3 of
 *   Claude 1's review of #2945);
 * - neither passkey manager is handed an empty list ("No passkeys yet."):
 *   the Passkeys section says the list could not be read just now, keeps its
 *   heading and its #passkeys anchor, and offers nothing on a guess;
 * - nothing is written: the passkey is still kept.
 * Controls: with the list read, the step is done and each manager gets the
 * passkey; with no passkey and no recovery address, both read, the step is
 * listed as not done.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { listPasskeys } from "@/lib/passkeys";
import { claimHandle, ensureStatsId } from "@/lib/store";
import StudioPage from "@/app/studio/page";
import { StudioStart, type StartStep } from "@/components/studio-start";
import * as passkeyModule from "@/components/passkey-manager";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const parts = passkeyModule as unknown as Record<string, unknown>;
const PasskeyManager = parts.PasskeyManager;
const UNKNOWN = "Could not be checked just now, so it is not marked done. Open this page again in a moment.";
const PasskeysUnread = typeof parts.PasskeysUnread === "function" ? (parts.PasskeysUnread as () => null) : null;

async function propsOf(node: unknown, type: unknown, found: Record<string, unknown>[] = [], seen = new Set<unknown>()): Promise<Record<string, unknown>[]> {
  if (!node || typeof node !== "object" || seen.has(node)) return found;
  seen.add(node);
  if (typeof (node as PromiseLike<unknown>).then === "function") return propsOf(await node, type, found, seen);
  if (Array.isArray(node)) {
    await Promise.all(node.map((child) => propsOf(child, type, found, seen)));
    return found;
  }
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    if (type && node.type === type) found.push(props);
    await Promise.all(Object.values(props).map((value) => propsOf(value, type, found, seen)));
  }
  return found;
}

async function studioOf(owner: string, fault: boolean) {
  const session = await openSession(owner);
  const listKey = `nl:pk:${hex(`nimbus-passkeys:${owner}`).slice(0, 40)}`;
  const kept = redis.pipeline;
  let faults = 0;
  if (fault)
    redis.pipeline = async (commands) => {
      if (commands.some((c) => c[0] === "GET" && c[1] === listKey)) {
        faults += 1;
        throw new Error("SYNTHETIC_PASSKEY_LIST_READ_FAULT");
      }
      return kept.call(redis, commands);
    };
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
  try {
    const tree = await StudioPage({ searchParams: Promise.resolve({}) });
    const starts = await propsOf(tree, StudioStart);
    const steps = starts.flatMap((p) => (p.steps as { key: string; done: boolean; unknown?: boolean }[]) ?? []);
    return {
      recovery: steps.filter((s) => s.key === "recovery").map((s) => s.done),
      unknown: steps.filter((s) => s.key === "recovery").map((s) => s.unknown === true),
      checklist: starts.map((p) => String(p.launchChecklist ?? "")).join("\n"),
      managers: (await propsOf(tree, PasskeyManager)).map((p) => (p.initial as unknown[]).length),
      unread: PasskeysUnread ? (await propsOf(tree, PasskeysUnread)).length : 0,
      faults,
    };
  } finally {
    redis.pipeline = kept;
    answering(null);
  }
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "c4-pk-unread@example.com";
  await claimHandle(OWNER, "c4pkunread", "Passkey unread", "");
  await ensureStatsId(OWNER);
  await makePasskey(OWNER, "cred-c4-pk-unread").keep();
  is("setup: the passkey is kept", (await listPasskeys(OWNER)).map((p) => p.id), ["cred-c4-pk-unread"]);

  part("control: the passkey list was read");
  const read = await studioOf(OWNER, false);
  is("the step is listed as done (a passkey is kept)", read.recovery, [true]);
  is("and is not marked unknown", read.unknown, [false]);
  is("each manager is handed the kept passkey", read.managers.length > 0 && read.managers.every((n) => n === 1), true);
  is("no unread notice when the list was read", read.unread, 0);

  part("the passkey list could not be read; no recovery address");
  const unread = await studioOf(OWNER, true);
  is("the fault happened on the passkey list", unread.faults > 0, true);
  is("the step is listed, never left out as if setup were complete", unread.recovery.length, 1);
  is("its check mark is unknown: not done, and marked as could not be checked", [unread.recovery, unread.unknown], [[false], [true]]);
  is("the saved checklist names it and says it could not be checked just now", unread.checklist.includes(`Keep a way back in — ${UNKNOWN}`), true);
  is("no manager is handed an empty list ('No passkeys yet.')", unread.managers, []);
  is("each Passkeys section says the list could not be read just now", unread.unread, read.managers.length);
  is("nothing was written: the passkey is still kept", (await listPasskeys(OWNER)).map((p) => p.id), ["cred-c4-pk-unread"]);

  part("the unread Passkeys section keeps its heading and anchor, and offers nothing on a guess");
  const html = PasskeysUnread ? renderToStaticMarkup(createElement(PasskeysUnread)) : "";
  is("anchor, heading, notice", [html.includes('id="passkeys"'), html.includes("Passkeys</h3>"), html.includes("Your passkeys could not be read just now. Nothing was changed; reload the page in a moment.")], [true, true, true]);
  is("never 'No passkeys yet.', and no add, remove or field", [html.includes("No passkeys yet."), /Add|Remove|<input|<button/.test(html)], [false, false]);

  part("control: no passkey and no recovery address, both read");
  const BARE = "c4-pk-none@example.com";
  await claimHandle(BARE, "c4pknone", "No passkey", "");
  await ensureStatsId(BARE);
  const bare = await studioOf(BARE, false);
  is("the step is listed as not done", bare.recovery, [false]);
  is("and is not marked unknown, nor said to be unchecked in the checklist", [bare.unknown, bare.checklist.includes(UNKNOWN)], [[false], false]);
  is("each manager is handed the empty list that was read", bare.managers.length > 0 && bare.managers.every((n) => n === 0), true);

  part("'Getting your store ready' never looks complete over a step that could not be checked");
  const allDone = (key: string): StartStep => ({ key, title: key, hint: "", done: true, href: "#" });
  const steps: StartStep[] = [...["product", "publish", "share", "details", "look"].map(allDone), { key: "recovery", title: "Keep a way back in", hint: "A recovery address or a passkey.", done: false, unknown: true, href: "#account-recovery" } as StartStep];
  const start = renderToStaticMarkup(createElement(StudioStart, { steps }));
  is("the list is still shown", start.includes("Getting your store ready"), true);
  is("the step says it could not be checked just now, also to a screen reader", [start.includes(UNKNOWN), start.includes("(could not be checked just now)")], [true, true]);
  is("it is not offered as the next step on a guess, nor marked done", [start.includes("Next: Keep a way back in"), /line-through[^>]*>Keep a way back in</.test(start)], [false, false]);
  const finished = renderToStaticMarkup(createElement(StudioStart, { steps: steps.map((s) => (s.key === "recovery" ? { ...s, done: true, unknown: false } : s)) }));
  is("control: with every step known and done, the list hides itself", finished, "");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
