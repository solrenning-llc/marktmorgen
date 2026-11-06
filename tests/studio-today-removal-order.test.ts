/**
 * 651 [WG11] unit 2, on Today (app/studio/page.tsx): the person's passkeys, and whether this session may add or keep
 * one, are read only after the passkeys whose wait has run out are removed (lib/passkeys.ts pendingRemoval), as before
 * the page sent its reads together. Read beside that removal, the list still held the passkey being removed, and the
 * studio showed a passkey that could no longer log in, with no removal date beside it.
 *
 * The real page, a real store and a real passkey set to be removed seven days and a minute ago (its removal record
 * written as lib/passkeys.ts writes one whose notice went out). What Today hands its passkey managers must not hold that passkey.
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
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
