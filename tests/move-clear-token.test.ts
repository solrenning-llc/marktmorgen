/**
 * A broken move's records are cleared only while they are still that move's own (Codex X5's MEDIUM on #2271): the
 * clearing, by the move route at its end or by a repair that read the record earlier, names the move it means (its
 * token, or for a record from before tokens, the exact text it read), so a late clearing never deletes the record of
 * a later move of the same addresses, nor gives back that move's place among the moves left open. Against the
 * in-memory Redis double only.
 */
import { clearBrokenMove, markBrokenMove, noteMoveCopy, readBrokenMove } from "@/lib/auth";
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const A = "ana@example.com";
const B = "bea@example.com";
const OPEN = "nl:auth:move-broken:open";
const placeOf = (op: string) => redis.run(["ZSCORE", OPEN, op]);
/** lib/auth.ts brokenKey, for an address already in its normal form. */
const brokenMoveKeyFor = async (email: string) => `nl:auth:move-broken:${createHash("sha256").update(`nimbus-auth-move-broken:${email}`).digest("hex").slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("Its own move: cleared, and its place given back");
  const own = await markBrokenMove(A, B);
  await clearBrokenMove(A, B, own);
  is("both records gone", [await readBrokenMove(A), await readBrokenMove(B)], [null, null]);
  is("its place given back", placeOf(own), null);

  part("A late clearing of the first move never deletes the second move of the same two addresses");
  const first = await markBrokenMove(A, B);
  await clearBrokenMove(A, B, first);
  const second = await markBrokenMove(A, B);
  await noteMoveCopy(A, B, "c".repeat(64), second);
  await clearBrokenMove(A, B, first);
  is("the second move's records stay", [(await readBrokenMove(A))?.to, (await readBrokenMove(B))?.from], [B, A]);
  is("and keep its copy", (await readBrokenMove(A))?.copy, "c".repeat(64));
  is("its place is still held", placeOf(second) !== null, true);
  await clearBrokenMove(A, B, second);
  is("its own clearing then clears it", [await readBrokenMove(A), await readBrokenMove(B), placeOf(second)], [null, null, null]);

  part("A record from before tokens is cleared by the exact text read, and only that");
  const legacy = JSON.stringify({ from: A, to: B, at: 1 });
  redis.run(["SET", await brokenMoveKeyFor(A), legacy]);
  redis.run(["SET", await brokenMoveKeyFor(B), legacy]);
  await clearBrokenMove(A, B, JSON.stringify({ from: A, to: B, at: 2 }));
  is("another text clears nothing", [Boolean(await readBrokenMove(A)), Boolean(await readBrokenMove(B))], [true, true]);
  await clearBrokenMove(A, B, legacy);
  is("its own text clears it", [await readBrokenMove(A), await readBrokenMove(B)], [null, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
