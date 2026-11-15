/**
 * Deletion counts above what was sent (same family as #4797, #4790 and #4798; C7, 15 November 2026): forgetDevice's
 * HDEL of one field and forgetReadings' DEL of a host's two readings were read only for a count, so 2 for one field or 3
 * for two keys was taken as done. A count is at most the distinct fields or keys sent; more throws UnknownReplyError.
 * Synthetic, the Redis stub.
 */
import { forgetDevice } from "@/lib/community-push";
import { removeHostIcs } from "@/lib/host-calendar";
import { hostId } from "@/lib/host-claims";
import { UnknownReplyError } from "@/lib/redis-reply";
import { seal } from "@/lib/secret-box";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => {
  throw new Error("Unexpected external request in a synthetic test");
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
/** Answers `reply` for the first pipeline whose first command `which` matches, Redis's own answer otherwise. */
function answer(which: (command: (string | number)[]) => boolean, reply: unknown[]): void {
  redis.pipeline = (async (commands: Commands) => (commands[0] && which(commands[0]) ? reply : real(commands))) as typeof redis.pipeline;
}
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "done";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  part("forgetDevice: an HDEL of one field answers 0 or 1, never more");
  {
    const COMMUNITY = "c7-del-count";
    const WHO = "a1a1a1a1a1a1";
    const KEY = `nl:cm:${COMMUNITY}:ps:${WHO}`;
    const ENDPOINT = "https://push.example.com/send/abc";
    const isHdel = (c: (string | number)[]) => c[0] === "HDEL" && c[1] === KEY;
    for (const [label, reply, said] of [["1", 1, "done"], ["0", 0, "done"], ["2", 2, "UnknownReplyError"], ["3", 3, "UnknownReplyError"]] as const) {
      redis.clear();
      redis.run(["HSET", KEY, ENDPOINT, JSON.stringify({ endpoint: ENDPOINT })]);
      answer(isHdel, [reply]);
      is(`HDEL of one field answered ${label}`, await outcome(() => forgetDevice(COMMUNITY, WHO, ENDPOINT)), said);
    }
  }

  part("forgetReadings (through removeHostIcs): a DEL of two keys answers 0 to 2, never more");
  {
    const EMAIL = "host@example.com";
    const HOST = hostId(EMAIL);
    const CFG = `nl:hostcal:cfg:${HOST}`;
    const GOOD = `nl:hostcal:good:${HOST}`;
    const isReadingsDel = (c: (string | number)[]) => c[0] === "DEL" && c[1] === GOOD;
    for (const [label, reply, said] of [["2", 2, "done"], ["0", 0, "done"], ["3", 3, "UnknownReplyError"], ["4", 4, "UnknownReplyError"]] as const) {
      redis.clear();
      redis.run(["SET", CFG, JSON.stringify({ email: EMAIL, source: "ics", read: ["primary"], write: "", ics: seal("https://calendar.example.com/private-abc123.ics", `hostcal|${HOST}|ics`), icsAddedAt: "2026-11-01T00:00:00.000Z" })]);
      answer(isReadingsDel, [reply]);
      is(`DEL of the two readings answered ${label}`, await outcome(() => removeHostIcs({ statsId: "s0000000000000000077" }, EMAIL)), said);
    }
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
