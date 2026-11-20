/**
 * #4800 (Codex V, transcribed by Claude 2): forgetFindToken deleted a buyer-page search token (which holds the address
 * in plain text for an hour) without reading the DEL's reply, so a short reply, text, a negative count, more than one
 * for one key or an extra reply was taken as done, and the route said the erasure was complete with the token kept.
 * Now only one reply, an exact 0 (already gone) or 1, is done; any other throws UnknownReplyError. Synthetic Redis
 * only; a fictional address.
 */
import { readFileSync } from "node:fs";
import { addressForToken, findToken, forgetFindToken } from "@/lib/buyer-profile";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STORE = { sid: "s".repeat(32) };
const EMAIL = "find-me@example.test";
const real = redis.pipeline.bind(redis);

async function forgetWith(reply: unknown[] | null): Promise<{ said: string; kept: boolean }> {
  redis.clear();
  const token = await findToken(STORE, EMAIL);
  if (!token) throw new Error("no token");
  redis.pipeline = (async (batch) => {
    if (reply !== null && batch[0]?.[0] === "DEL") return reply;
    return real(batch);
  }) as typeof redis.pipeline;
  let said: string;
  try {
    await forgetFindToken(token);
    said = "done";
  } catch (error) {
    said = error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  } finally {
    redis.pipeline = real;
  }
  return { said, kept: (await addressForToken(STORE, token)) === EMAIL };
}

async function main(): Promise<void> {
  part("Control: the real DEL consumes the token");
  is("done, and the token is gone", await forgetWith(null), { said: "done", kept: false });
  part("Exact counts are done");
  is("0 (already gone) is done", (await forgetWith([0])).said, "done");
  is("1 is done", (await forgetWith([1])).said, "done");
  part("Any other reply is unknown: the erasure is never said complete on it");
  for (const [what, reply] of [["no reply", []], ["text", ["1"]], ["-1", [-1]], ["2 for one key", [2]], ["an extra reply", [1, 0]], ["null", [null]], ["a fraction", [0.5]]] as [string, unknown[]][]) {
    is(`${what}: unknown`, (await forgetWith(reply)).said, "unknown");
  }
  part("The buyer page's erase: a token not confirmed deleted is a part not finished, to be pressed again");
  const route = readFileSync("app/api/store/person/route.ts", "utf8");
  const erase = route.slice(route.indexOf('if (body.action === "erase")'), route.indexOf("const store = guarded.store.statsId"));
  is("the token's deletion is caught, never a crash nor \"complete\"", /try\s*\{\s*await forgetFindToken\(token\);?\s*\}\s*catch/.test(erase), true);
  is("and answered as incomplete, naming the part, for the same retry the erasure's own parts get", /error: "incomplete", failed: \["lib\/buyer-profile\.ts"\]/.test(erase), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
