/**
 * Forgetting a Discord server (lib/discord-store.ts, forgetServer), on "Disconnect the server" in the studio
 * (app/api/store/discord/route.ts). The proof is Claude 6's (tests/discord-forget-unknown-proof.test.ts on
 * claude6/c5-proofs): an unknown HVALS reply was read as "no members", so the links from each buyer's address to
 * their Discord id (nl:dc:addr:*) outlived the disconnect, and an unknown HKEYS reply left the members' due
 * entries behind. Read exactly now (CX-123 rule 24, lib/redis-reply.ts): an unknown reply throws before anything is
 * deleted, so everything is kept for the next try, and the studio hears an honest "not_finished" (503), never
 * "disconnected" with a buyer's address still kept. Synthetic data, the memory Redis and a stand-in for Discord.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { emailKey, storeKey } from "@/lib/learn";
import { accountOf, forgetServer, keepMember, membersOf, readServer, saveServer } from "@/lib/discord-store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as manageDiscord } from "@/app/api/store/discord/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.DISCORD_CLIENT_ID = "400000000000000001";
process.env.DISCORD_CLIENT_SECRET = "secret";
process.env.DISCORD_BOT_TOKEN = "bot";

const SERVER = "100000000000000031";
const ANA = "300000000000000031";
const BEN = "300000000000000032";
let left = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname.replace(/^\/api\/v10/, "");
  if ((init?.method ?? "GET") === "DELETE" && path === `/users/@me/guilds/${SERVER}`) {
    left += 1;
    // The first leave removes the bot; a second answers 404, which leaveServer reads as "it is out".
    return left === 1 ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ code: 10004 }), { status: 404 });
  }
  return new Response(JSON.stringify({ message: "no stand-in" }), { status: 404 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** Bends the next one-command read of `command` to `reply`, once. */
function bendOnce(command: string, reply: unknown): void {
  let once = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (once && commands.length === 1 && commands[0][0] === command) {
      once = false;
      return reply as never;
    }
    return real(commands);
  }) as typeof redis.pipeline;
}
const unbend = () => {
  redis.pipeline = real;
};

const ODD: [string, unknown, string][] = [
  ["HVALS", [42], "HVALS answers a list holding a number"],
  ["HVALS", 42, "HVALS answers a number"],
  ["HVALS", ["x"], "HVALS answers a one-slot reply, not a list of rows"],
  ["HVALS", [], "HVALS answers no slot at all"],
  ["HVALS", [["{not json"]], "HVALS answers a row that is not a person"],
  ["HKEYS", [42], "HKEYS answers a list holding a number"],
  ["HKEYS", 42, "HKEYS answers a number"],
  ["HKEYS", [], "HKEYS answers no slot at all"],
];

async function main(): Promise<void> {
  const ROOM = "forgetroom";
  const SID = "sid_forget";
  const seed = async (room: string, sid: string) => {
    await saveServer(room, { id: SERVER, name: "The Club", at: 1, kick: false });
    await keepMember(room, sid, ANA, { e: "ana@example.com", n: "Ana", p: [], r: [], at: 1, checked: 1 });
    await keepMember(room, sid, BEN, { e: "ben@example.com", n: "Ben", p: [], r: [], at: 2, checked: 1 });
  };
  const due = async (sid: string, id: string) => (await real([["ZSCORE", "nl:dc:due", `${sid}|${id}`]]))[0] !== null;
  const kept = async (room: string, sid: string) => [
    (await readServer(room))?.id ?? null,
    (await membersOf(room)).length,
    await accountOf(room, "ana@example.com"),
    await accountOf(room, "ben@example.com"),
    await due(sid, ANA),
    await due(sid, BEN),
  ];
  const ALL = [SERVER, 2, ANA, BEN, true, true];
  const NONE = [null, 0, null, null, false, false];

  part("Healthy control: everything kept for the server is forgotten");
  redis.clear();
  await seed(ROOM, SID);
  is("seeded: the server, two people, their address links and due entries", await kept(ROOM, SID), ALL);
  is("forgetServer counts the two people", await forgetServer(ROOM, SID), 2);
  is("and nothing is left: no server, no person, no address link, no due entry", await kept(ROOM, SID), NONE);
  is("the address keys themselves are gone", (await real([["EXISTS", `nl:dc:addr:${ROOM}:${emailKey("ana@example.com")}`]]))[0], 0);

  for (const [command, reply, label] of ODD) {
    part(`Unknown reply (Claude 6's proof): ${label}`);
    redis.clear();
    await seed(ROOM, SID);
    bendOnce(command, reply);
    let thrown: unknown = null;
    try {
      await forgetServer(ROOM, SID);
    } catch (error) {
      thrown = error;
    }
    unbend();
    is(`${label}: forgetServer throws UnknownReplyError, never "nobody kept"`, thrown instanceof UnknownReplyError, true);
    is(`${label}: nothing is deleted, so the next try still knows every address`, await kept(ROOM, SID), ALL);
    is(`${label}: the next try, read exactly, forgets everything`, [await forgetServer(ROOM, SID), ...(await kept(ROOM, SID))], [2, ...NONE]);
  }

  // Codex G on #3017 (CXG-20261109-B3-3017): a reading of the people that is not whole (a shorter list, from a bent
  // reply or a person joining or leaving between the two reads) deleted every person while forgetting only the
  // addresses it read, so a buyer's address stayed linked to their Discord id for good, and Disconnect said "done".
  const CUT: [string[], string][] = [
    [["HVALS"], "HVALS answers one row short"],
    [["HKEYS"], "HKEYS answers one person short"],
    [["HKEYS", "HVALS"], "both answer one short"],
  ];
  for (const [commands, label] of CUT) {
    part(`A reading that is not whole: ${label}`);
    redis.clear();
    await seed(ROOM, SID);
    const cut = new Set(commands);
    redis.pipeline = (async (sent: (string | number)[][]) => {
      const answers = await real(sent);
      if (sent.length === 1 && cut.has(String(sent[0][0]))) {
        cut.delete(String(sent[0][0]));
        return answers.map((answer) => (Array.isArray(answer) ? answer.slice(0, -1) : answer)) as never;
      }
      return answers;
    }) as typeof redis.pipeline;
    let thrown: unknown = null;
    try {
      await forgetServer(ROOM, SID);
    } catch (error) {
      thrown = error;
    }
    unbend();
    is(`${label}: not "forgotten": forgetServer throws UnknownReplyError`, thrown instanceof UnknownReplyError, true);
    const [server, people, ana, ben] = await kept(ROOM, SID);
    const members = new Set((await membersOf(ROOM)).map((m) => m.id));
    is(`${label}: no buyer's address outlives their person`, [ana !== null && !members.has(ANA), ben !== null && !members.has(BEN)], [false, false]);
    is(`${label}: the server is kept while anybody is`, server === null && (people as number) > 0, false);
    is(`${label}: the next try, read exactly, forgets everything`, [await forgetServer(ROOM, SID).then(() => "done", () => "threw"), ...(await kept(ROOM, SID))], ["done", ...NONE]);
  }

  part("The studio's \"Disconnect the server\" answers honestly");
  redis.clear();
  const OWNER = "discord-forget-server@example.com";
  await claimHandle(OWNER, "discordforget", "Discord Forget", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestDiscForg01", true);
  await setSubscription(OWNER, { customerId: "cus_DiscForg01", subscriptionId: "sub_DiscForg01", active: true, period: paidPeriod() });
  const product = await addProduct(OWNER, "The Club", "", "20", null);
  if (!product.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  const session = await openSession(OWNER);
  const manage = async (body: Record<string, unknown>) => {
    const response = await manageDiscord(new NextRequest(`https://marktmorgen.com/api/store/discord?store=${store.sid}`, { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; people?: number } };
  };
  await seed(room, store.sid);
  bendOnce("HVALS", 42);
  const first = await manage({ action: "disconnect" });
  unbend();
  is("an unknown read while forgetting: 503 not_finished, never \"disconnected\"", [first.status, first.body.ok, first.body.error], [503, false, "not_finished"]);
  is("the bot did leave (Discord was asked once)", left, 1);
  is("everything is kept for the next try, the buyers' address links included", await kept(room, store.sid), ALL);
  const again = await manage({ action: "disconnect" });
  is("pressing again (Discord answers 404: already out) disconnects, counting the two people", [again.status, again.body.ok, again.body.people], [200, true, 2]);
  is("and only then is everything forgotten", await kept(room, store.sid), NONE);

  const studio = readFileSync("components/discord-studio.tsx", "utf8");
  is("the studio has words for \"not_finished\": the bot left, disconnecting did not finish, try again", /not_finished: "[^"]*bot left[^"]*could not finish[^"]*try again/i.test(studio), true);
  done();
}
main();
