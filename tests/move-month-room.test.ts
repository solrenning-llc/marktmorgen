/**
 * A move of the sign-in address takes a unit of a monthly room before anything moves, and the old record is never
 * deleted after its lock may have run out (#2271: Codex G2's MEDIUM, kept by Claude 1's decision; Claude 5's LOW 1).
 *
 * 1. Each store moves at most MOVES_PER_STORE_PER_MONTH times a calendar month (UTC), counted by the store, never by
 *    the address, so a store moving from address to address finds no fresh count; the company pays for at most
 *    MOVES_PER_MONTH moves a month, all stores together. Past either, the tap is refused before markMoving: nothing
 *    moves and the move's EVAL (NOTE_MOVE_COPY) is never sent. A count that does not read is a refusal too.
 * 2. moveAccount notes the copy's print before it writes, and makes the old address's lock last again right before
 *    the last step that deletes the old record: a write that landed on the old address meanwhile is never lost.
 *
 * Synthetic only: a stand-in Redis; the move link is written as sendMoveLink writes it, with no email sent.
 */
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { MOVES_PER_MONTH, MOVES_PER_STORE_PER_MONTH, openSession } from "@/lib/auth";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { StoreBusyError, claimHandle, createStore, moveAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let sent: Command[] = [];
redis.pipeline = async (commands: Command[]) => {
  sent.push(...commands);
  return real(commands);
};
const ORIGIN = "https://marktmorgen.com";
const form = (fields: Record<string, string>) =>
  new NextRequest(`${ORIGIN}/api/auth/move`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
const noteSent = () => sent.some((command) => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:move-copy-note:v1"));
const where = (location: string) => location.replace(/^.*[?&](status|address)=/, "");

/**
 * One tap of a fresh move link from `from` to `to`, as the person would: where it lands. The link is the record
 * sendMoveLink writes (lib/auth.ts moveKey), for a session open at `from`.
 */
async function move(from: string, to: string): Promise<string> {
  const session = await openSession(from);
  const token = randomBytes(32).toString("hex");
  const key = `nl:auth:move:${createHash("sha256").update(`nimbus-auth-move:${token}`).digest("hex").slice(0, 40)}`;
  await real([["SET", key, JSON.stringify({ from, to, session }), "EX", 900]]);
  sent = [];
  return where((await moveRoute(form({ token }))).headers.get("location") ?? "");
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("1. a store moves at most MOVES_PER_STORE_PER_MONTH times a month, whatever address it is at");
  const A = "room-a@example.com";
  const B = "room-b@example.com";
  await claimHandle(A, "room-store", "Room", "");
  const landed: string[] = [];
  let at = A;
  for (let i = 0; i < MOVES_PER_STORE_PER_MONTH; i += 1) {
    const next = at === A ? B : A;
    landed.push(await move(at, next));
    at = next;
  }
  is("every move within the month's room lands", landed.every((place) => place === "moved"), true);
  const other = at === A ? B : A;
  is("the next one is refused as the month's count", await move(at, other), "move-month");
  is("nothing moved: the store is where it was", [Boolean(await storeForEmail(at)), Boolean(await storeForEmail(other))], [true, false]);
  is("and the move's EVAL was never sent", noteSent(), false);

  part("2. a new month gives the store its room again");
  const clock = Date.now;
  try {
    const now = new Date(clock());
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2);
    Date.now = () => next;
    is("moved in the next month", await move(at, other), "moved");
  } finally {
    Date.now = clock;
  }

  part("3. the company's room for the month, all stores together");
  const month = new Date().toISOString().slice(0, 7);
  await real([["SET", `nl:auth:move-room:${month}`, String(MOVES_PER_MONTH), "EX", 32 * 86_400]]);
  const C = "room-c@example.com";
  const D = "room-d@example.com";
  await claimHandle(C, "room-other", "Other", "");
  is("another store's move is refused as the company's month", await move(C, D), "move-paused");
  is("nothing moved", [Boolean(await storeForEmail(C)), Boolean(await storeForEmail(D))], [true, false]);
  is("and the move's EVAL was never sent", noteSent(), false);
  await real([["DEL", `nl:auth:move-room:${month}`]]);

  part("4. a count that does not read is a refusal, never room");
  const shapes: unknown[] = [null, "1", { 0: 1 }, -1, 1.5];
  const answers: string[] = [];
  for (const bad of shapes) {
    redis.pipeline = async (commands: Command[]) => {
      sent.push(...commands);
      const replies = await real(commands);
      return replies.map((reply, i) => (commands[i][0] === "INCR" && String(commands[i][1]).startsWith("nl:auth:move-room:") ? bad : reply));
    };
    try {
      answers.push(await move(C, D));
    } finally {
      redis.pipeline = async (commands: Command[]) => {
        sent.push(...commands);
        return real(commands);
      };
    }
  }
  is("each unknown count answers move-error", answers, shapes.map(() => "move-error"));
  is("nothing moved", [Boolean(await storeForEmail(C)), Boolean(await storeForEmail(D))], [true, false]);
  is("control: the same move with the count read lands", await move(C, D), "moved");

  part("5. a write that lands on the old address while the copy is noted is never lost (Claude 5, LOW 1)");
  const E = "room-e@example.com";
  const F = "room-f@example.com";
  await claimHandle(E, "room-gap", "Gap", "");
  let lock = "";
  redis.pipeline = async (commands: Command[]) => {
    for (const command of commands) {
      if (!lock && command[0] === "SET" && String(command[1]).startsWith("nl:store:lock:") && command[3] === "NX") lock = String(command[1]);
    }
    return real(commands);
  };
  let outcome = "";
  try {
    const result = await moveAccount(E, F, async () => {
      // The old address's lock runs out while the copy is noted, and a payment's answer writes there meanwhile.
      await real([["DEL", lock]]);
      await setSubscription(E, { subscriptionId: "sub_Gap0001", active: true });
    });
    outcome = result.ok ? "moved" : result.reason;
  } catch (error) {
    outcome = error instanceof StoreBusyError ? "busy" : String(error);
  } finally {
    redis.pipeline = real;
  }
  const kept = [await storeForEmail(E), await storeForEmail(F)].filter(Boolean).map((one) => one?.subscriptionId);
  is("the subscription written meanwhile is kept at an address", kept.includes("sub_Gap0001"), true);
  is("the move is refused as busy, nothing at the new address", [outcome, Boolean(await storeForEmail(F))], ["busy", false]);

  part("6. rule 30: the same with the account's other stores, whose writes do not hold the old address's lock");
  const G = "room-g@example.com";
  const H = "room-h@example.com";
  await claimHandle(G, "room-many", "Many", "");
  const extra = await createStore(G, "room-many-two", "Many two", "");
  is("(an extra store)", extra.ok, true);
  lock = "";
  let struck = false;
  let busy = false;
  redis.pipeline = async (commands: Command[]) => {
    for (const command of commands) {
      if (!lock && command[0] === "SET" && String(command[1]).startsWith("nl:store:lock:") && command[3] === "NX") lock = String(command[1]);
    }
    const replies = await real(commands);
    // Right after the extra store is written at the new owner, the old address's lock runs out and a write lands there.
    if (!struck && !busy && commands.some((command) => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:fenced-set:v1"))) {
      struck = true;
      busy = true;
      await real([["DEL", lock]]);
      await setSubscription(G, { subscriptionId: "sub_Gap0002", active: true });
      busy = false;
    }
    return replies;
  };
  let many = "";
  try {
    const result = await moveAccount(G, H);
    many = result.ok ? "moved" : result.reason;
  } catch (error) {
    many = error instanceof StoreBusyError ? "busy" : String(error);
  } finally {
    redis.pipeline = real;
  }
  is("(the lock was struck during the extra store's write)", struck, true);
  const left = [await storeForEmail(G), await storeForEmail(H)].filter(Boolean).map((one) => one?.subscriptionId);
  is("the subscription written meanwhile is kept at an address", left.includes("sub_Gap0002"), true);
  is("the move stops as busy before the old record is deleted", [many, Boolean(await storeForEmail(G))], ["busy", true]);
  done();
}

void main();
