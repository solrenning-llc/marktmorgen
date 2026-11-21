/**
 * A move's late write of the store copy's fingerprint (lib/auth.ts
 * noteMoveCopy) lands only on that move's own record (Codex H on #2271,
 * C3-133): markBrokenMove makes a token for each move, and the copy is
 * written, in one script, only where the record still carries it. Against
 * the in-memory Redis double only.
 */
import { clearBrokenMove, markBrokenMove, noteMoveCopy, readBrokenMove } from "@/lib/auth";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const A = "ana@example.com";
const B = "bea@example.com";
const C = "cid@example.com";
const COPY = "a".repeat(64);
const OTHER = "b".repeat(64);

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("Its own move: the copy is noted on both addresses");
  const own = await markBrokenMove(A, B);
  is("a token, made for this move", /^[0-9a-f]{64}$/.test(own), true);
  await noteMoveCopy(A, B, COPY, own);
  is("noted on both", [(await readBrokenMove(A))?.copy, (await readBrokenMove(B))?.copy], [COPY, COPY]);
  await clearBrokenMove(A, B, own);

  part("Codex H's barrier: a late write of a cleared move never lands on the move that replaced it");
  const old = await markBrokenMove(A, B);
  await clearBrokenMove(A, B, old);
  const replaced = await markBrokenMove(A, C);
  await noteMoveCopy(A, B, COPY, old);
  is("A's record is still A to C, with no copy", await readBrokenMove(A), { from: A, to: C, op: replaced });
  is("and nothing is written for B, whose move was cleared", await readBrokenMove(B), null);
  await noteMoveCopy(A, C, OTHER, replaced);
  is("the move that replaced it notes its own copy", [(await readBrokenMove(A))?.copy, (await readBrokenMove(C))?.copy], [OTHER, OTHER]);
  await clearBrokenMove(A, C, replaced);

  part("The same two addresses moved again: the first move's late write does not land on the second");
  const first = await markBrokenMove(A, B);
  await clearBrokenMove(A, B, first);
  const second = await markBrokenMove(A, B);
  is("(a new token for the second)", first !== second, true);
  await noteMoveCopy(A, B, COPY, first);
  is("the second move's record has no copy", [(await readBrokenMove(A))?.copy, (await readBrokenMove(B))?.copy], [undefined, undefined]);
  await noteMoveCopy(A, B, OTHER, second);
  is("its own write lands", [(await readBrokenMove(A))?.copy, (await readBrokenMove(B))?.copy], [OTHER, OTHER]);

  part("Codex X5 on #2271: a late clear of a move never deletes the move that replaced it");
  // A repair that read the second move's record clears it; a slower repair that read the first one (already cleared)
  // comes after a third move of the same two addresses: it must leave that one's record and its place alone.
  await clearBrokenMove(A, B, second);
  const third = await markBrokenMove(A, B);
  await clearBrokenMove(A, B, first);
  is("the third move's record is still there, on both addresses, with its own token", [(await readBrokenMove(A))?.op, (await readBrokenMove(B))?.op], [third, third]);
  const [score] = await redis.pipeline([["ZSCORE", "nl:auth:move-broken:open", third]]);
  is("and its place is still held", score !== null, true);
  const route = readFileSync("app/api/auth/move/route.ts", "utf8");
  const repair = readFileSync("lib/move-repair.ts", "utf8");
  is("every clear names the move it read: the route its own token, the repairs the record's", [route.includes("clearBrokenMove(from, to, op)"), (repair.match(/clearBrokenMove\([^)]*, (broken\.)?op \?\? null\)/g) ?? []).length, /clearBrokenMove\([^,)]*,[^,)]*\)/.test(route + repair)], [true, 2, false]);
  await clearBrokenMove(A, B, third);
  is("cleared by its own token", [await readBrokenMove(A), await readBrokenMove(B)], [null, null]);

  part("A record written before moves had a token: cleared only by a clear that names none");
  const key = async (email: string) => `nl:auth:move-broken:${createHash("sha256").update(`nimbus-auth-move-broken:${email}`).digest("hex").slice(0, 40)}`;
  const legacy = JSON.stringify({ from: A, to: B, at: 1 });
  await redis.pipeline([["SET", await key(A), legacy], ["SET", await key(B), legacy]]);
  is("read with no token", await readBrokenMove(A), { from: A, to: B });
  await clearBrokenMove(A, B, "c".repeat(64));
  is("a clear naming a move is not it: kept", (await readBrokenMove(B))?.to, B);
  await clearBrokenMove(A, B, null);
  is("a clear naming none clears it", [await readBrokenMove(A), await readBrokenMove(B)], [null, null]);
  await redis.pipeline([["SET", await key(A), JSON.stringify({ from: A, to: B, at: 1, op: 7 })]]);
  is("a token that is not text: the record is unknown, never read", await readBrokenMove(A).then(() => "read", (error: Error) => error.name), "UnknownReplyError");
  await redis.pipeline([["DEL", await key(A)]]);

  part("A move already cleared is never marked again");
  await noteMoveCopy(A, B, COPY, second);
  is("nothing written", [await readBrokenMove(A), await readBrokenMove(B)], [null, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
