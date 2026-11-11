/**
 * Disconnecting a meeting account reads the connection only in its exact
 * shape (CX-123 rule 24), so "nothing was connected" is said only for a
 * confirmed none (lib/meet-connect.ts, disconnect).
 *
 * Before, any reply that was not a connection's text (a missing slot, a
 * number, a list, an object) and any text that was not a connection read as
 * "none connected": the creator pressed Disconnect, the studio answered ok and
 * showed the account gone, while the connection with its sealed tokens stayed
 * kept here and its access was never given back. Now:
 *   - the slot answered null: nothing was connected, nothing is written;
 *   - a reply of another shape: unknown, disconnect throws (the route answers
 *     500, "try again"), and nothing is claimed;
 *   - text kept there that is not a connection (damaged): the creator asked to
 *     end it, so it is deleted, and said as nothing that could be given back;
 *   - a deletion is confirmed by its own count, or disconnect throws.
 * The same holds for a team host's own Google connection (lib/host-calendar.ts,
 * disconnectHostGoogle).
 *
 * Synthetic store and Redis (tests/redis-stub.ts); every outbound request
 * throws, so no provider is reached.
 */
import { disconnect } from "@/lib/meet-connect";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let outbound = 0;
globalThis.fetch = (async () => {
  outbound++;
  throw Error("Unexpected external request in a synthetic test");
}) as typeof fetch;

type Commands = (string | number)[][];
const SID = "s0000000000000000-meetdisc";
const HOST = "0123456789abcdef01234567";
const KEY = `nl:meet:conn:${SID}:google`;
const HOST_KEY = `nl:meet:conn:hosts:google:h:${HOST}`;
// Not sealed: nothing can be opened from it, so nothing is sent to Google when it is given back.
const HEALTHY = {
  provider: "google",
  account: { id: "acct-synthetic", email: "creator@example.test", name: "" },
  access: "not-sealed",
  expires: 0,
  refresh: "not-sealed",
  scope: "",
  connectedAt: 1_800_000_000_000,
  by: "creator@example.test",
  owner: { email: "creator@example.test", handle: "synthetic" },
  broken: "",
  brokenAt: 0,
};

const pipe = redis.pipeline.bind(redis);
/** The real store's replies, with the command `name` on `key` answered as given. */
const answering = (name: string, key: string, reply: unknown) => {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    return replies.map((r, i) => (commands[i][0] === name && commands[i][1] === key ? reply : r));
  }) as typeof redis.pipeline;
};
/** The pipeline's whole answer replaced as given, for the GET of the connection only. */
const answeringAll = (key: string, replies: unknown) => {
  redis.pipeline = (async (commands: Commands) =>
    commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key ? replies : pipe(commands)) as unknown as typeof redis.pipeline;
};
const restore = () => {
  redis.pipeline = pipe as typeof redis.pipeline;
};
const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    const view = (await run()) as { account?: string } | null;
    return view ? `disconnected ${view.account}` : "none";
  } catch {
    return "unknown";
  }
};
const kept = async (key: string) => (await redisPipeline([["GET", key]]))[0];

async function main(): Promise<void> {
  part("Controls: a kept connection is disconnected, a confirmed none is none");
  redis.clear();
  await redisPipeline([["SET", KEY, JSON.stringify(HEALTHY)]]);
  is("healthy: disconnected, and nothing kept", [await outcome(() => disconnect(SID, "google")), await kept(KEY)], ["disconnected creator@example.test", null]);
  is("confirmed none (null): none", await outcome(() => disconnect(SID, "google")), "none");
  await redisPipeline([["SET", HOST_KEY, JSON.stringify(HEALTHY)]]);
  is("a host's own: disconnected, and nothing kept", [await outcome(() => disconnect(SID, "google", HOST)), await kept(HOST_KEY)], ["disconnected creator@example.test", null]);

  const odd: [string, unknown][] = [
    ["a missing slot (undefined)", undefined],
    ["a number", 42],
    ["true", true],
    ["a list", [JSON.stringify(HEALTHY)]],
    ["an object, not text", { ...HEALTHY }],
  ];
  part("A reply of another shape is unknown: never \"none connected\"");
  for (const [shape, reply] of odd) {
    for (const [who, key, host] of [["the store's", KEY, ""], ["a host's", HOST_KEY, HOST]] as const) {
      redis.clear();
      await redisPipeline([["SET", key, JSON.stringify(HEALTHY)]]);
      answering("GET", key, reply);
      const said = await outcome(() => disconnect(SID, "google", host));
      restore();
      is(`${who}, the connection answered as ${shape}: unknown, and the connection is not claimed gone`, said, "unknown");
    }
  }
  for (const [shape, replies] of [["no reply", []], ["two replies", [null, null]], ["not a list", { 0: null }], ["a hole", new Array(1)]] as [string, unknown][]) {
    redis.clear();
    await redisPipeline([["SET", KEY, JSON.stringify(HEALTHY)]]);
    answeringAll(KEY, replies);
    const said = await outcome(() => disconnect(SID, "google"));
    restore();
    is(`the pipeline answered ${shape}: unknown`, said, "unknown");
  }

  part("Text kept there that is not a connection: the creator asked to end it, so it goes");
  for (const [shape, text] of [["empty text", ""], ["text cut short", "{cut"], ["an empty record", "{}"], ["another provider's", JSON.stringify({ ...HEALTHY, provider: "zoom" })], ["no refresh token", JSON.stringify({ ...HEALTHY, refresh: 7 })]] as [string, string][]) {
    redis.clear();
    await redisPipeline([["SET", KEY, text]]);
    const said = await outcome(() => disconnect(SID, "google"));
    is(`${shape}: answered as nothing to give back, and nothing is kept`, [said, await kept(KEY)], ["none", null]);
  }

  part("A deletion is confirmed by its own count");
  for (const [shape, reply] of [["a missing slot (undefined)", undefined], ["text", "1"], ["a negative", -1], ["null", null]] as [string, unknown][]) {
    redis.clear();
    await redisPipeline([["SET", KEY, JSON.stringify(HEALTHY)]]);
    answering("DEL", KEY, reply);
    const said = await outcome(() => disconnect(SID, "google"));
    restore();
    is(`the deletion answered ${shape}: unknown, never "disconnected"`, said, "unknown");
  }

  is("no request left for any provider", outbound, 0);
  done();
}

void main();
