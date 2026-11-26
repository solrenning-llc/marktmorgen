/**
 * Issue #3973 (Codex G; rule 24, security): a session let in without the second step (lib/two-step.ts
 * openLockedSession) is refused by every API route for what moves money or data out (studioAccess, LOCKED_NEEDS),
 * but the studio's pages read through studioView, which never asked about the lock: a locked browser could open
 * /studio/team (member addresses, the activity log), /studio/disputes (disputed purchases), /studio/invoices (the
 * plan's Stripe invoices) and every other page behind a locked permission, and the page read it all. Now studioView
 * asks the same question as studioAccess, before anything of the store is read: a locked session is sent to
 * /studio?two-step=locked (as creatorFrom already sends it), and a lock that could not be read is never read as
 * free: it is sent to /studio?two-step=unread, whose top says in plain words that the page asked for was not opened
 * because the sign-in could not be checked (tests/studio-lock-unread.test.ts). What a locked session keeps (orders,
 * products, a page with no permission) still opens.
 *
 * Synthetic only: the in-memory Redis, a synthetic store and sessions.
 */
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { studioView } from "@/lib/studio-route";
import { LOCKED_NEEDS, openLockedSession } from "@/lib/two-step";
import type { Permission } from "@/lib/team-roles";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const original = redis.pipeline.bind(redis);
/** Whether the session's lock read (one MGET) fails, while set. */
let lockFails = false;
/** Every command sent, while counting. */
let sent: string[] | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (sent) sent.push(...commands.map((command) => `${command[0]} ${String(command[1] ?? "")}`));
  if (lockFails && commands.length === 1 && commands[0]?.[0] === "MGET" && String(commands[0]?.[1]).startsWith("nl:2fa:locked:")) {
    throw new Error("the lock's read failed");
  }
  return original(commands);
}) as typeof redis.pipeline;

const jar = (session: string) => ({ get: (name: string) => (name === SESSION_COOKIE ? { value: session } : undefined) });

/** What studioView did: opened the page, refused it, or sent the browser somewhere (Next's redirect). */
async function view(session: string, need: Permission | "member" | null): Promise<string> {
  try {
    const found = await studioView(jar(session), undefined, need as never, { count: false });
    return found.ok ? "opened" : `refused ${found.reason}`;
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return `sent to ${digest.split(";")[2]}`;
    throw error;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "locked-view@example.com";
  if (!(await claimHandle(owner, "lockedview", "Locked view", "")).ok) throw new Error("no store");
  await ensureStatsId(owner);
  const full = await openSession(owner);
  const locked = await openLockedSession(owner, Date.now() + 7 * 86_400_000);

  part("Control: a full session opens every page");
  for (const need of [...LOCKED_NEEDS, "orders", "products", null] as (Permission | null)[]) {
    is(`${need ?? "no permission"}: opened`, await view(full, need), "opened");
  }

  part("A locked session: every page behind a locked permission is sent to the lock's notice, nothing read");
  for (const need of LOCKED_NEEDS as Permission[]) {
    sent = [];
    const answer = await view(locked, need);
    const reads = sent;
    sent = null;
    is(`${need}: sent to the lock's notice`, answer, "sent to /studio?two-step=locked");
    is(`${need}: nothing of the store was read`, reads.filter((command) => /nl:(store|team|aff|plan|stats)/.test(command)), []);
  }

  part("A locked session keeps what is not locked");
  for (const need of ["orders", "products", "member", null] as (Permission | "member" | null)[]) {
    is(`${need ?? "no permission"}: opened`, await view(locked, need), "opened");
  }

  part("The lock could not be read: never read as free");
  lockFails = true;
  // The studio's home reads the marker and says why the page asked for was not opened (tests/studio-lock-unread.test.ts).
  is("team: sent to the studio with the unread marker, so its top says why", await view(locked, "team"), "sent to /studio?two-step=unread");
  is("billing: the same", await view(full, "billing"), "sent to /studio?two-step=unread");
  is("orders: not locked, so the lock is not asked", await view(locked, "orders"), "opened");
  lockFails = false;

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
