/**
 * A repair or a clearing of a broken move that runs late never deletes a later move's record nor its copy (Codex X5
 * on #2271: "the broken-move cleanup ignores the op token; a late repair can delete the record of a later move").
 * Every delete of the repair path is fenced, in the same script as the delete, by the token of the move it was read
 * for (lib/auth.ts CLEAR_BROKEN_MOVE, lib/store.ts settleDoubledStore through its guard): a record that carries
 * another move's token is left, with its place among the open moves, and the copy that move left is left with it.
 *
 * 1. a late clearing of move A, after move B of one of its addresses took its place: B's record and place stay
 * 2. a late repair of move A, after A was repaired and B moved the store again and broke: B's record and copy stay
 * 3. A's own repair, run on time, still settles the store and clears A's record and place
 * 4. a record written before moves carried a token is cleared by its exact text, and only while it is that text
 *
 * Synthetic only: a stand-in Redis; a move is broken by refusing its last step, as a lost connection would.
 */
import { createHash } from "node:crypto";
import { clearBrokenMove, markBrokenMove, noteMoveCopy, readBrokenMove } from "@/lib/auth";
import { repairMove } from "@/lib/move-repair";
import { claimHandle, moveAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ownerKey = (email: string) => `nl:store:owner:${sha(`nimbus-store:${email.toLowerCase()}`).slice(0, 40)}`;
const brokenKey = (email: string) => `nl:auth:move-broken:${sha(`nimbus-auth-move-broken:${email.toLowerCase()}`).slice(0, 40)}`;
const OPEN = "nl:auth:move-broken:open";

async function opOf(email: string): Promise<string | null> {
  const [raw] = await real([["GET", brokenKey(email)]]);
  if (typeof raw !== "string") return null;
  const op = (JSON.parse(raw) as { op?: unknown }).op;
  return typeof op === "string" ? op : null;
}

async function placeHeld(op: string): Promise<boolean> {
  const [score] = await real([["ZSCORE", OPEN, op]]);
  return score !== null && score !== undefined;
}

/** The store moved from `from` to `to` as the route moves it, its record marked first, and its last step lost: both records stay. */
async function brokenMove(from: string, to: string): Promise<string> {
  const op = await markBrokenMove(from, to);
  if (op === "full") throw new Error("no place");
  const old = ownerKey(from);
  redis.pipeline = async (commands: Command[]) => {
    if (commands.some((command) => command[0] === "DEL" && command[1] === old)) throw new Error("connection lost");
    return real(commands);
  };
  try {
    await moveAccount(from, to, (copy) => noteMoveCopy(from, to, copy, op)).catch(() => null);
  } finally {
    redis.pipeline = real;
  }
  return op;
}

const both = async (a: string, b: string) => [Boolean(await storeForEmail(a)), Boolean(await storeForEmail(b))];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  console.error = () => {};

  part("1. a late clearing of move A never deletes the record of move B, which took its place since");
  const A1 = "late-a1@example.com";
  const B1 = "late-b1@example.com";
  const C1 = "late-c1@example.com";
  const opA = await markBrokenMove(A1, B1);
  const lateA = await readBrokenMove(A1);
  await clearBrokenMove(A1, B1, opA);
  const opB = await markBrokenMove(B1, C1);
  is("(B has its own token)", typeof opB === "string" && opB !== opA, true);
  await clearBrokenMove(lateA?.from ?? A1, lateA?.to ?? B1, opA).catch(() => null);
  is("B's record stays at B, with B's token", await opOf(B1), opB);
  is("and at C", await opOf(C1), opB);
  is("B's place among the open moves stays", await placeHeld(String(opB)), true);
  await clearBrokenMove(B1, C1, String(opB));
  is("B's own clearing still clears B", [await readBrokenMove(B1), await readBrokenMove(C1), await placeHeld(String(opB))], [null, null, false]);

  part("2. a late repair of move A never deletes the record of move B, of the same two addresses, nor the copy B left");
  const A2 = "late-a2@example.com";
  const B2 = "late-b2@example.com";
  await claimHandle(A2, "late-two", "Store late two", "");
  await brokenMove(A2, B2);
  is("(A's move left both records)", await both(A2, B2), [true, true]);
  let opB2 = "";
  let interleaved = false;
  let calls = 0;
  // The late repair reads A's record, then, before its next step, another repair of A finishes and a second move, B,
  // of the same two addresses breaks the same way.
  redis.pipeline = async (commands: Command[]) => {
    calls += 1;
    if (calls === 2 && !interleaved) {
      interleaved = true;
      redis.pipeline = real;
      is("(the repair on time settles A's move)", await repairMove(A2), true);
      is("(the store is kept at A alone, where its handle points)", await both(A2, B2), [true, false]);
      const op = await brokenMove(A2, B2);
      opB2 = op;
      is("(B's move left both records)", await both(A2, B2), [true, true]);
      redis.pipeline = async (next: Command[]) => real(next);
    }
    return real(commands);
  };
  try {
    await repairMove(A2);
  } finally {
    redis.pipeline = real;
  }
  is("(the late repair ran across B's move)", interleaved, true);
  is("B's record stays at A, with B's token", await opOf(A2), opB2);
  is("and at B", await opOf(B2), opB2);
  is("B's place stays", await placeHeld(opB2), true);
  is("both records of the store stay, for B's own repair", await both(A2, B2), [true, true]);
  is("B's own repair then settles it", await repairMove(B2), true);
  is("and clears B's record and place", [await readBrokenMove(A2), await readBrokenMove(B2), await placeHeld(opB2)], [null, null, false]);
  is("the store is kept at one address", (await both(A2, B2)).filter(Boolean).length, 1);

  part("3. A's own repair, on time, still repairs");
  const A3 = "late-a3@example.com";
  const B3 = "late-b3@example.com";
  await claimHandle(A3, "late-three", "Store late three", "");
  const opA3 = await brokenMove(A3, B3);
  is("repaired", await repairMove(A3), true);
  is("the copy is deleted", (await both(A3, B3)).filter(Boolean).length, 1);
  is("A's record and place are gone", [await readBrokenMove(A3), await readBrokenMove(B3), await placeHeld(opA3)], [null, null, false]);

  part("4. a record with no token, written before moves carried one, is cleared by its exact text only");
  const A4 = "late-a4@example.com";
  const B4 = "late-b4@example.com";
  const legacy = JSON.stringify({ from: A4, to: B4, at: 1 });
  await real([["SET", brokenKey(A4), legacy], ["SET", brokenKey(B4), legacy]]);
  await claimHandle(B4, "late-four", "Store late four", "");
  is("the repair clears it", await repairMove(A4), true);
  is("both records gone", [await readBrokenMove(A4), await readBrokenMove(B4)], [null, null]);
  done();
}

main().catch((error) => {
  console.error = (...args: unknown[]) => process.stderr.write(`${args.join(" ")}\n`);
  console.error(error);
  process.exit(1);
});
