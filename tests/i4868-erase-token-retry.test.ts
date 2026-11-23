/**
 * #5285 row #4868, Claude 3's two LOWs on #4868 @3198e861cb (7005572174, kept in 20261123T132036Z-claude-3-4f08):
 *
 *   1. When the search token's DEL ran but its reply did not read, the erase route answered 503 "incomplete". The
 *      second press then found no token and answered 410 "expired", not success, although the person and the token
 *      were both gone.
 *   2. That second press ran erasePerson again for a person already erased. If the run was refused (for example by
 *      `limit`), the token, which holds the address, was spent only by its own TTL (FIND_SECONDS, an hour).
 *
 * Now, when the DEL does not answer, the token's place is written over with the erasure's answer, without the
 * address (keepErasedAnswer). Once that is kept, the erasure is complete. A press again reads that answer
 * (findTokenState) and answers the same, without running the erasure twice. Synthetic Redis only; a fictional
 * address.
 */
import { readFileSync } from "node:fs";
import { FIND_SECONDS, addressForToken, findToken, findTokenState, keepErasedAnswer } from "@/lib/buyer-profile";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STORE = { sid: "s".repeat(32) };
const OTHER = { sid: "o".repeat(32) };
const EMAIL = "find-me@example.test";
const real = redis.pipeline.bind(redis);
const key = (token: string) => `nl:person:find:${token}`;

async function fresh(): Promise<string> {
  redis.clear();
  const token = await findToken(STORE, EMAIL);
  if (!token) throw new Error("no token");
  return token;
}

async function main(): Promise<void> {
  part("A token found reads as its address, on its own store only");
  {
    const token = await fresh();
    is("the address", await findTokenState(STORE, token), { kind: "address", email: EMAIL });
    is("on another store: nothing", await findTokenState(OTHER, token), { kind: "none" });
    is("a malformed token: nothing", await findTokenState(STORE, "x".repeat(48)), { kind: "none" });
  }

  part("After an erasure whose token delete did not answer, the token holds the answer, never the address");
  {
    const token = await fresh();
    await keepErasedAnswer(STORE, token, { records: 7, notes: ["discord-roles"] });
    const [raw] = await real([["GET", key(token)]]);
    is("the address is gone from the token", String(raw).includes(EMAIL), false);
    is("LOW 1: a press again reads the erasure's own answer, not \"expired\"", await findTokenState(STORE, token), { kind: "erased", records: 7, notes: ["discord-roles"] });
    is("and the buyer page reads no address from it", await addressForToken(STORE, token), null);
    is("on another store: nothing", await findTokenState(OTHER, token), { kind: "none" });
    const [ttl] = await real([["TTL", key(token)]]);
    is("kept FIND_SECONDS at the most from when the answer is written (a SET with EX, never without an expiry)", typeof ttl === "number" && ttl > 0 && ttl <= FIND_SECONDS, true);
  }

  part("The answer is written exactly, or the erasure is said not finished");
  for (const [what, reply] of [["no reply", []], ["null", [null]], ["text", ["ok"]], ["an extra reply", ["OK", "OK"]]] as [string, unknown[]][]) {
    const token = await fresh();
    redis.pipeline = (async (batch) => (batch[0]?.[0] === "SET" ? reply : real(batch))) as typeof redis.pipeline;
    let said = "kept";
    try {
      await keepErasedAnswer(STORE, token, { records: 1, notes: [] });
    } catch (error) {
      said = error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
    } finally {
      redis.pipeline = real;
    }
    is(`${what}: unknown`, said, "unknown");
  }

  part("An answer that does not read as an erasure's is nothing, never trusted");
  {
    const token = await fresh();
    for (const [what, value] of [
      ["an unknown note", { s: STORE.sid, erased: true, r: 1, n: ["anything"] }],
      ["records not a count", { s: STORE.sid, erased: true, r: -1, n: [] }],
      ["no records", { s: STORE.sid, erased: true, n: [] }],
    ] as [string, unknown][]) {
      await real([["SET", key(token), JSON.stringify(value), "EX", 60]]);
      is(`${what}: nothing`, await findTokenState(STORE, token), { kind: "none" });
    }
  }

  part("The erase route: a press again answers the kept answer, and the erasure runs once (LOW 2)");
  const route = readFileSync("app/api/store/person/route.ts", "utf8");
  const erase = route.slice(route.indexOf('if (body.action === "erase")'), route.indexOf("const store = guarded.store.statsId"));
  const kept = erase.indexOf('if (state.kind === "erased") return erased(state.records, state.notes);');
  is("the token is read once, as its state", /const state = await findTokenState\(guarded\.store, token\);/.test(erase), true);
  is("an erased token answers its answer before the erasure is run", kept > -1 && kept < erase.indexOf("await erasePerson("), true);
  is("the address the erasure runs on is the token's own", erase.includes("await erasePerson(guarded.store, state.email,"), true);
  is("a delete that does not answer writes the answer in the token's place", /catch \(error\) \{[\s\S]*?await keepErasedAnswer\(guarded\.store, token, \{ records: result\.records, notes: result\.notes \}\);/.test(erase), true);
  is("and only when that is not kept either, the erasure is said not finished", /catch \(keepError\) \{[\s\S]*?error: "incomplete", failed: \["lib\/buyer-profile\.ts"\]/.test(erase), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
