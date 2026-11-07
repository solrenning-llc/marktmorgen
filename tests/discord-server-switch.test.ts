/**
 * Switching the connected Discord server (app/api/discord/callback/route.ts): a creator adds the bot to another
 * server, and the old one is let go with whoever it gave roles to. The review of #3017 (Claude 4 team, MÉDIO, and
 * rv28, LEVE): the connected server was read leniently, so an unknown GET read as "no server" and the new server was
 * written over the old one, leaving the bot in the old server and each buyer's address linked to their Discord id
 * for good, under "connected"; forgetServer's UnknownReplyError was not caught, so the creator landed on a bare 500
 * after the code was spent; and the old server's people were forgotten before Discord confirmed the bot left, with
 * that failure ignored. Now: the server is read exactly ("unavailable", nothing changed), the bot leaves the old
 * server first ("server", nothing forgotten, when Discord refuses), and an unknown read while forgetting says
 * "not_finished" with everything kept for the next try. Synthetic data, the memory Redis and a stand-in for Discord.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { storeKey } from "@/lib/learn";
import { accountOf, keepMember, membersOf, readServer, saveServer, startTrip } from "@/lib/discord-store";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
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
const OWNER = "discord-server-switch@example.com";
const real = redis.pipeline.bind(redis);

/** What Discord was asked, and, when the bot was told to leave the old server, how many people were still kept then. */
const asked: string[] = [];
let keptAtLeave: number | null = null;
let leaveStatus = 204;
let room = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname.replace(/^\/api\/v10/, "");
  const method = init?.method ?? "GET";
  asked.push(`${method} ${path}`);
  if (method === "POST" && path === "/oauth2/token") return Response.json({ access_token: "synthetic_token", guild: { id: NEW, name: "The New Club" } });
  if (method === "DELETE" && path === `/users/@me/guilds/${OLD}`) {
    const [held] = await real([["HLEN", `nl:dc:mem:${room}`]]);
    keptAtLeave = Number(held);
    if (leaveStatus === 204) leaveStatus = 404; // Out now: a second leave answers 404, read as "it is out".
    else if (leaveStatus === 404) return Response.json({ code: 10004 }, { status: 404 });
    else return Response.json({ message: "synthetic outage" }, { status: leaveStatus });
    return new Response(null, { status: 204 });
  }
  return Response.json({ message: "no stand-in" }, { status: 404 });
}) as typeof fetch;

/** Bends the next one-command read of `command` on `key` (any key when omitted) to `reply`, once. */
function bendOnce(command: string, reply: unknown, key?: string): void {
  let once = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (once && commands.length === 1 && commands[0][0] === command && (key === undefined || commands[0][1] === key)) {
      once = false;
      return reply as never;
    }
    return real(commands);
  }) as typeof redis.pipeline;
}
const unbend = () => {
  redis.pipeline = real;
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "discordswitch", "Discord Switch", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestDiscSw01", true);
  await setSubscription(OWNER, { customerId: "cus_DiscSwitch01", subscriptionId: "sub_DiscSwitch01", active: true, period: paidPeriod() });
  const product = await addProduct(OWNER, "The Club", "", "20", null);
  if (!product.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  room = storeKey(store);
  const session = await openSession(OWNER);
  const redirect = "https://marktmorgen.com/api/discord/callback";

  const seed = async () => {
    await saveServer(room, { id: OLD, name: "The Old Club", at: 1, kick: false });
    await keepMember(room, store.sid, ANA, { e: "ana@example.com", n: "Ana", p: [], r: [], at: 1, checked: 1 });
    await keepMember(room, store.sid, BEN, { e: "ben@example.com", n: "Ben", p: [], r: [], at: 2, checked: 1 });
    asked.length = 0;
    keptAtLeave = null;
    leaveStatus = 204;
  };
  const due = async (id: string) => (await real([["ZSCORE", "nl:dc:due", `${store.sid}|${id}`]]))[0] !== null;
  const kept = async () => [
    (await readServer(room))?.id ?? null,
    (await membersOf(room)).length,
    await accountOf(room, "ana@example.com"),
    await accountOf(room, "ben@example.com"),
    await due(ANA),
    await due(BEN),
  ];
  const OLD_KEPT = [OLD, 2, ANA, BEN, true, true];
  const SWITCHED = [NEW, 0, null, null, false, false];
  const leaves = () => asked.filter((call) => call === `DELETE /users/@me/guilds/${OLD}`).length;
  /** The creator comes back from Discord's page; the notice it lands on, or "threw" for a bare 500. */
  const comeBack = async (): Promise<string> => {
    const state = await startTrip({ k: "install", sid: store.sid, by: OWNER, redirect });
    try {
      const response = await returnDiscord(new NextRequest(`${redirect}?state=${state}&code=synthetic_install_code`, { headers: { host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` } }));
      return new URL(response.headers.get("location") ?? "https://none.invalid/").searchParams.get("discord") ?? "none";
    } catch (error) {
      // The success path ends with after() (the creator's notice), which has no request scope in a test: it is
      // reached only once the switch was written, so it stands for "connected" here; anything else is a bare 500.
      return error instanceof Error && error.message.includes("`after` was called outside a request scope") ? "connected" : "threw";
    }
  };

  part("Healthy control: the bot leaves the old server first, then the old server's people are forgotten");
  await seed();
  is("seeded: the old server, two people, their address links and due entries", await kept(), OLD_KEPT);
  is("the switch is connected", await comeBack(), "connected");
  is("Discord was asked once to take the bot out of the old server", leaves(), 1);
  is("when it was asked, the old server's people were still kept (forgotten only once it confirmed)", keptAtLeave, 2);
  is("and then: the new server is kept, nobody of the old one, no address link, no due entry", await kept(), SWITCHED);

  part("Discord refuses to take the bot out of the old server: nothing is forgotten");
  await seed();
  leaveStatus = 500;
  is("the creator hears \"server\", never \"connected\"", await comeBack(), "server");
  is("the old server stays connected with its people and their address links", await kept(), OLD_KEPT);

  const ODD_SERVER: [unknown, string][] = [
    [[42], "GET answers a number"],
    [["{not json"], "GET answers a row that is not a server"],
    [[], "GET answers no slot at all"],
  ];
  for (const [reply, label] of ODD_SERVER) {
    part(`The connected server read in another shape (Claude 4 team's proof): ${label}`);
    await seed();
    bendOnce("GET", reply, `nl:dc:srv:${room}`);
    const notice = await comeBack();
    unbend();
    is(`${label}: "unavailable", never "connected" over the old server`, notice, "unavailable");
    is(`${label}: the bot is not told to leave anything`, leaves(), 0);
    is(`${label}: the old server, its people and their address links are all kept`, await kept(), OLD_KEPT);
  }

  part("An unknown read while forgetting the old server (rv28's proof): no bare 500, nothing forgotten");
  await seed();
  bendOnce("HVALS", 42);
  const unfinished = await comeBack();
  unbend();
  is("the creator hears \"not_finished\", not a bare 500", unfinished, "not_finished");
  is("the bot did leave the old server", leaves(), 1);
  is("the old server is still kept, with its people and their address links, for the next try", await kept(), OLD_KEPT);
  is("the next try (Discord answers 404: already out) connects the new server", await comeBack(), "connected");
  is("and only then is the old server's data forgotten", await kept(), SWITCHED);

  part("The Discord page has words for each answer");
  const page = readFileSync("app/studio/discord/page.tsx", "utf8");
  is("unavailable: could not read, nothing connected", /unavailable: \{ tone: "error", text: "[^"]*could not read[^"]*" \}/.test(page), true);
  is("server: the old server is still connected", /server: \{ tone: "error", text: "[^"]*old server is still connected[^"]*" \}/.test(page), true);
  is("not_finished: the bot left the old server, try again", /not_finished: \{ tone: "error", text: "[^"]*bot left your old server[^"]*[Tt]ry again[^"]*" \}/.test(page), true);
  done();
}
main();
