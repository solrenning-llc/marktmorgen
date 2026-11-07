/**
 * A move's late write of the store copy's fingerprint (lib/auth.ts
 * noteMoveCopy) lands only on that move's own record (Codex H on #2271,
 * C3-133): markBrokenMove makes a token for each move, and the copy is
 * written, in one script, only where the record still carries it. Against
 * the in-memory Redis double only.
 */
import { clearBrokenMove, markBrokenMove, noteMoveCopy, readBrokenMove } from "@/lib/auth";
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
  await clearBrokenMove(A, B);

  part("Codex H's barrier: a late write of a cleared move never lands on the move that replaced it");
  const old = await markBrokenMove(A, B);
  await clearBrokenMove(A, B);
  const replaced = await markBrokenMove(A, C);
  await noteMoveCopy(A, B, COPY, old);
  is("A's record is still A to C, with no copy", await readBrokenMove(A), { from: A, to: C });
  is("and nothing is written for B, whose move was cleared", await readBrokenMove(B), null);
  await noteMoveCopy(A, C, OTHER, replaced);
  is("the move that replaced it notes its own copy", [(await readBrokenMove(A))?.copy, (await readBrokenMove(C))?.copy], [OTHER, OTHER]);
  await clearBrokenMove(A, C);

  part("The same two addresses moved again: the first move's late write does not land on the second");
  const first = await markBrokenMove(A, B);
  await clearBrokenMove(A, B);
  const second = await markBrokenMove(A, B);
  is("(a new token for the second)", first !== second, true);
  await noteMoveCopy(A, B, COPY, first);
  is("the second move's record has no copy", [(await readBrokenMove(A))?.copy, (await readBrokenMove(B))?.copy], [undefined, undefined]);
  await noteMoveCopy(A, B, OTHER, second);
  is("its own write lands", [(await readBrokenMove(A))?.copy, (await readBrokenMove(B))?.copy], [OTHER, OTHER]);

  part("A move already cleared is never marked again");
  await clearBrokenMove(A, B);
  await noteMoveCopy(A, B, COPY, second);
  is("nothing written", [await readBrokenMove(A), await readBrokenMove(B)], [null, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
