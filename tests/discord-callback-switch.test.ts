/**
 * Switching the connected Discord server on the install callback (app/api/discord/callback/route.ts): the creator
 * added the bot to another server, so the old one is let go, with whoever it gave roles to. Review of #3017
 * (Claude 4 team, MEDIUM; rv28, LIGHT): the callback read the connected server leniently, so an unknown GET was "no
 * server" and the new server was written over the old one, whose people and buyers' address links (nl:dc:addr:*)
 * were never forgotten and which the bot never left, under "discord=connected"; it forgot the old server's data
 * before leaving it and ignored a failed leave; and forgetServer's new UnknownReplyError ended on a bare 500 after
 * the OAuth code was spent. Now, as in "Disconnect the server": the server is read exactly, the bot leaves first,
 * data is forgotten only once Discord confirmed it left, and every unknown or failed step answers an honest notice
 * with the old server, its people and their address links kept, so trying again finishes the switch.
 * Synthetic data, the memory Redis and a stand-in for Discord.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { storeKey } from "@/lib/learn";
import { accountOf, keepMember, membersOf, readServer, saveServer, startTrip } from "@/lib/discord-store";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET as returnDiscord } from "@/app/api/discord/callback/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.DISCORD_CLIENT_ID = "400000000000000001";
process.env.DISCORD_CLIENT_SECRET = "secret";
process.env.DISCORD_BOT_TOKEN = "bot";

const OLD = "100000000000000041";
const NEW = "100000000000000042";
const ANA = "300000000000000041";
const BEN = "300000000000000042";

/** What Discord answers the bot's leave of the old server: "ok" (204), "out" (404, already gone) or "down" (500). */
let leaveAnswer: "ok" | "out" | "down" = "ok";
let leaves = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname.replace(/^\/api\/v10/, "");
  const method = init?.method ?? "GET";
  if (method === "POST" && path === "/oauth2/token") {
    return new Response(JSON.stringify({ access_token: "synthetic_token", guild: { id: NEW, name: "The New Club" } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (method === "DELETE" && path === `/users/@me/guilds/${OLD}`) {
    leaves += 1;
    if (leaveAnswer === "ok") return new Response(null, { status: 204 });
    if (leaveAnswer === "out") return new Response(JSON.stringify({ code: 10004 }), { status: 404 });
    return new Response(JSON.stringify({ message: "synthetic outage" }), { status: 500 });
  }
  return new Response(JSON.stringify({ message: "no stand-in" }), { status: 404 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** Whether the last bend reached its read. */
let bendUsed = false;
/** Bends the next one-command read of `command` (on `key`, when given) to `reply`, once. */
function bendOnce(command: string, reply: unknown, key?: string): void {
  let once = true;
  bendUsed = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (once && commands.length === 1 && commands[0][0] === command && (key === undefined || commands[0][1] === key)) {
      once = false;
      bendUsed = true;
      return reply as never;
    }
    return real(commands);
  }) as typeof redis.pipeline;
}
const unbend = () => {
  redis.pipeline = real;
};

async function main(): Promise<void> {
  const OWNER = "discord-callback-switch@example.com";
  const REDIRECT = "https://marktmorgen.com/api/discord/callback";
  const setUp = async () => {
    redis.clear();
    await claimHandle(OWNER, "discordswitch", "Discord Switch", "");
    await ensureStatsId(OWNER);
    await ensureStoreId(OWNER);
    await setStripeAccount(OWNER, "acct_1TestDiscSwit01", true);
    await setSubscription(OWNER, { customerId: "cus_DiscSwit01", subscriptionId: "sub_DiscSwit01", active: true, period: paidPeriod() });
    const store = (await storeForEmail(OWNER))!;
    const room = storeKey(store);
    await saveServer(room, { id: OLD, name: "The Old Club", at: 1, kick: false });
    await keepMember(room, store.sid, ANA, { e: "ana@example.com", n: "Ana", p: [], r: [], at: 1, checked: 1 });
    await keepMember(room, store.sid, BEN, { e: "ben@example.com", n: "Ben", p: [], r: [], at: 2, checked: 1 });
    const session = await openSession(OWNER);
    return { store, room, session };
  };
  const callback = async (sid: string, session: string) => {
    const state = await startTrip({ k: "install", sid, by: OWNER, redirect: REDIRECT });
    const response = await returnDiscord(new NextRequest(`${REDIRECT}?state=${state}&code=synthetic_install_code`, { headers: { host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` } }));
    return { status: response.status, discord: new URL(response.headers.get("location") ?? "https://none.invalid/").searchParams.get("discord") };
  };
  const callbackCaught = async (sid: string, session: string) => {
    try {
      return await callback(sid, session);
    } catch (error) {
      return { status: 500, discord: `threw ${error instanceof Error ? error.name : "something"}` };
    }
  };
  const kept = async (room: string) => [
    (await readServer(room))?.id ?? null,
    (await membersOf(room)).length,
    await accountOf(room, "ana@example.com"),
    await accountOf(room, "ben@example.com"),
  ];
  const OLD_KEPT = [OLD, 2, ANA, BEN];
  const SWITCHED = [NEW, 0, null, null];

  part("Healthy control: the bot leaves the old server, its people are forgotten, the new one is connected");
  {
    const { store, room, session } = await setUp();
    leaveAnswer = "ok";
    leaves = 0;
    is("seeded: the old server, two people and their address links", await kept(room), OLD_KEPT);
    is("the return says connected", await callback(store.sid, session), { status: 303, discord: "connected" });
    is("the bot was asked once to leave the old server", leaves, 1);
    is("the new server is connected and nothing of the old one is kept", await kept(room), SWITCHED);
  }

  part("An unknown read of the connected server is not \"no server\" (MEDIUM, rule 30)");
  {
    const { store, room, session } = await setUp();
    leaveAnswer = "ok";
    leaves = 0;
    bendOnce("GET", [42], `nl:dc:srv:${room}`);
    const answer = await callbackCaught(store.sid, session);
    const bent = bendUsed;
    unbend();
    is("the bend reached the connected server's read (not an earlier GET)", bent, true);
    is("the return says unavailable, never connected", answer, { status: 303, discord: "unavailable" });
    is("the bot was not asked to leave a server nobody could read", leaves, 0);
    is("the old server, its people and their address links are kept, the new one is not written over them", await kept(room), OLD_KEPT);
    is("trying again, read exactly, finishes the switch", [await callback(store.sid, session), leaves, await kept(room)], [{ status: 303, discord: "connected" }, 1, SWITCHED]);
  }

  part("Discord does not confirm the bot left the old server: nothing is forgotten");
  {
    const { store, room, session } = await setUp();
    leaveAnswer = "down";
    leaves = 0;
    is("the return says the old server stays, never connected", await callback(store.sid, session), { status: 303, discord: "old_server" });
    is("the old server, its people and their address links are kept", await kept(room), OLD_KEPT);
    leaveAnswer = "ok";
    is("trying again once Discord answers finishes the switch", [await callback(store.sid, session), await kept(room)], [{ status: 303, discord: "connected" }, SWITCHED]);
  }

  part("The bot left, but who was kept could not be read exactly (LIGHT: no bare 500)");
  {
    const { store, room, session } = await setUp();
    leaveAnswer = "ok";
    leaves = 0;
    bendOnce("HVALS", 42);
    const answer = await callbackCaught(store.sid, session);
    unbend();
    is("the return says not finished, never a thrown error nor connected", answer, { status: 303, discord: "not_finished" });
    is("the bot did leave the old server", leaves, 1);
    is("nothing was forgotten and the new server was not written over the old people", await kept(room), OLD_KEPT);
    leaveAnswer = "out";
    is("trying again (Discord answers 404: already out) finishes the switch", [await callback(store.sid, session), leaves, await kept(room)], [{ status: 303, discord: "connected" }, 2, SWITCHED]);
  }

  part("The studio has words for each new notice");
  const page = readFileSync("app/studio/discord/page.tsx", "utf8");
  for (const code of ["unavailable", "old_server", "not_finished"]) {
    is(`app/studio/discord/page.tsx has a notice for discord=${code}`, new RegExp(`\\n\\s*${code}: \\{ tone: "error"`).test(page), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
