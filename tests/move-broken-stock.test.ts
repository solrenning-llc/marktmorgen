/**
 * #2271, Claude 1's review 6800796209 (Codex G's funding MEDIUM 6789950680, still open for this part) and Claude 5's
 * three LOWs (6748276312), still on head 4e2781a966:
 *
 * 1. MEDIUM: a broken move's two records have no expiry, on purpose, and no code capped how many stay open: the stock
 *    grew with every move left unrepaired, with no ceiling taken before the spend. Now every record a move writes
 *    (lib/auth.ts markBrokenMove, written before anything moves) holds a place among MAX_OPEN_BROKEN_MOVES, taken in
 *    the same script that writes it; with every place held, nothing is written and the tap is refused before
 *    anything moves ("move-held", said as such, never as the month's count); clearing the record (the move finished or undone, or repaired) gives the place back. The stock is
 *    then bounded and priced (tests/plan-cost-registry.ts MOVES_MONTH_KEPT), and no longer an open unknown.
 * 2. LOW 1: a renewal that did not go through, or a disputed plan, is not "paid" for the month's room
 *    (lib/plan-standing.ts costStandingOf, the repo's "paid up" rule), so it takes the others' room.
 * 3. LOW 2: an account that pays for an extra store only is a paying account: its move takes the paid room.
 * 4. LOW 3: a reply about the account's stores cut short is unknown and refuses the tap; it never reads as "no store",
 *    which skipped the store's own ten-a-month count.
 *
 * Synthetic only: a stand-in Redis; the move link is written as sendMoveLink writes it, with no email sent.
 */
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import * as auth from "@/lib/auth";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { claimHandle, createStore, setSubscription, storeForEmail } from "@/lib/store";
import * as registry from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let sent: Command[] = [];
let cut: ((commands: Command[]) => unknown[] | null) | null = null;
redis.pipeline = async (commands: Command[]) => {
  sent.push(...commands);
  const cutShort = cut?.(commands);
  if (cutShort) return cutShort;
  return real(commands);
};
const ORIGIN = "https://marktmorgen.com";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const form = (fields: Record<string, string>) =>
  new NextRequest(`${ORIGIN}/api/auth/move`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
const where = (location: string) => location.replace(/^.*[?&](status|address)=/, "");
const brokenKeys = () => [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((key) => /^nl:auth:move-broken:[0-9a-f]{40}$/.test(key));
const month = () => new Date().toISOString().slice(0, 7);
const roomTaken = (kind: "paid" | "unpaid") => sent.some((c) => c[0] === "INCR" && c[1] === `nl:auth:move-room:${month()}:${kind}`);

async function move(from: string, to: string): Promise<string> {
  const session = await auth.openSession(from);
  const token = randomBytes(32).toString("hex");
  const key = `nl:auth:move:${sha(`nimbus-auth-move:${token}`).slice(0, 40)}`;
  await real([["SET", key, JSON.stringify({ from, to, session }), "EX", 900]]);
  sent = [];
  return where((await moveRoute(form({ token }))).headers.get("location") ?? "");
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const mark = auth.markBrokenMove as (from: string, to: string) => Promise<string | "full">;
  const most = (auth as Record<string, unknown>).MAX_OPEN_BROKEN_MOVES;

  part("1. broken moves left open are bounded, the place taken in the same write");
  is("MAX_OPEN_BROKEN_MOVES is a positive whole number", typeof most === "number" && Number.isSafeInteger(most) && most > 0, true);
  const cap = typeof most === "number" && Number.isSafeInteger(most) && most > 0 && most <= 5_000 ? most : 3;
  // Every place held by moves left broken (or still running).
  for (let i = 0; i < cap; i += 1) await mark(`held-${i}@example.com`, `held-${i}-to@example.com`);
  const held = brokenKeys().length;
  is("each open move holds its two records", held, 2 * cap);
  const refused = await mark("over-a@example.com", "over-b@example.com");
  is("with every place held, the next move's record is refused", refused, "full");
  is("and nothing of it is written", brokenKeys().length, held);
  await auth.clearBrokenMove("held-0@example.com", "held-0-to@example.com");
  const again = await mark("over-a@example.com", "over-b@example.com");
  is("clearing one gives its place back", typeof again === "string" && /^[A-Za-z0-9_-]{16,}$/.test(again), true);
  await auth.clearBrokenMove("over-a@example.com", "over-b@example.com");

  part("1b. the tap is refused before anything moves, and its running mark ends");
  await mark("held-0@example.com", "held-0-to@example.com");
  const F = "full-from@example.com";
  const T = "full-to@example.com";
  await claimHandle(F, "full-store", "Full", "");
  is("a tap with every place held is held back", await move(F, T), "move-held");
  // Its page says what is true: not "until next month" (the places come back as moves are repaired, not with the month).
  const signin = readFileSync("app/signin/page.tsx", "utf8");
  const heldWords = signin.slice(signin.indexOf('"move-held": {'), signin.indexOf("},", signin.indexOf('"move-held": {')));
  is("the sign-in page explains it", heldWords.includes("title:") && heldWords.includes("old address"), true);
  is("without promising the next month", /next month|on the 1st/.test(heldWords), false);
  is("the store stayed where it was", [Boolean(await storeForEmail(F)), Boolean(await storeForEmail(T))], [true, false]);
  is("its running mark was taken off at once", await auth.moveRunning(F), false);
  is("and no record of its own was written", brokenKeys().length, 2 * cap);

  part("1c. the stock is priced, not an open unknown");
  const r = registry as Record<string, unknown>;
  const unknowns = Array.isArray(r.MOVE_COST_UNKNOWNS) ? (r.MOVE_COST_UNKNOWNS as string[]) : [];
  is("no open item is the broken moves' stock any more", unknowns.some((line) => line.toLowerCase().startsWith("broken moves kept")), false);
  is("the registry prices the open places the code keeps", r.MOVE_BROKEN_OPEN_MOST, most);

  for (let i = 0; i < cap; i += 1) await auth.clearBrokenMove(`held-${i}@example.com`, `held-${i}-to@example.com`);
  is("clearing every one leaves no record", brokenKeys().length, 0);

  part("2. LOW 1: a renewal that did not go through takes the others' room");
  const G = "grace-from@example.com";
  await claimHandle(G, "grace-store", "Grace", "");
  await setSubscription(G, { customerId: "cus_grace0001", subscriptionId: "sub_grace0001", active: true, tier: "creator", period: paidPeriod() });
  const ownerKey = (email: string) => `nl:store:owner:${sha(`nimbus-store:${email.toLowerCase()}`).slice(0, 40)}`;
  const graceRecord = JSON.parse(String((await real([["GET", ownerKey(G)]]))[0])) as Record<string, unknown>;
  await real([["SET", ownerKey(G), JSON.stringify({ ...graceRecord, renewalUnpaidSince: Math.floor(Date.now() / 1000) - 3600 })]]);
  is("its move lands", await move(G, "grace-to@example.com"), "moved");
  is("in the unpaid room, not the paid one", [roomTaken("unpaid"), roomTaken("paid")], [true, false]);

  part("3. LOW 2: an account that pays for an extra store only takes the paid room");
  const X = "extra-from@example.com";
  await claimHandle(X, "extra-first", "First", "");
  const made = await createStore(X, "extra-second", "Second", "");
  is("control: the extra store is made", made.ok, true);
  if (made.ok) await setSubscription(`#${made.store.sid}`, { customerId: "cus_extra0001", subscriptionId: "sub_extra0001", active: true, tier: "creator", period: paidPeriod() });
  is("its move lands", await move(X, "extra-to@example.com"), "moved");
  is("in the paid room", [roomTaken("paid"), roomTaken("unpaid")], [true, false]);

  part("4. LOW 3: a reply about the stores cut short refuses the tap");
  const S = "short-from@example.com";
  await claimHandle(S, "short-store", "Short", "");
  const owner = ownerKey(S);
  cut = (commands) => (commands.some((c) => c[0] === "GET" && c[1] === owner) && !commands.some((c) => c[0] === "SET") ? [] : null);
  const answer = await move(S, "short-to@example.com");
  cut = null;
  is("the tap is refused as a move that could not be done", answer, "move-error");
  is("no month's room was taken", sent.some((c) => c[0] === "INCR" && String(c[1]).startsWith("nl:auth:move-room:")), false);
  is("the store stayed where it was", Boolean(await storeForEmail(S)), true);
  done();
}

void main();
