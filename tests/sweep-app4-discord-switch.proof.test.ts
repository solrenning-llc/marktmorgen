/**
 * Sweep APP4 proof (CX-123 rule 24), synthetic only: Redis is the in-memory double, Discord a stand-in.
 *
 * app/api/discord/callback/route.ts:65-76 — a creator adds the bot to a NEW server. The route reads the server kept
 * so far with `readServer(room)` (lib/discord-store.ts:44-48: `parseServer(parse(raw))`, so a GET answering in any
 * other shape is `null`, "no server connected"). On that null the old server is never forgotten (forgetServer) and
 * the bot never leaves it (leaveServer): the new server id is written over the old one, while the old server's
 * product roles, member records (with the buyers' addresses) and due checks stay attached to the store and are now
 * read against the NEW server's id. The bot stays in the old server, where the store no longer looks, so the paid
 * roles it gave there are never checked or taken back again, and the creator was told "connected".
 *
 * Healthy control: the GET answers normally — the old server is forgotten and left (DELETE /users/@me/guilds/OLD).
 * DEFECT: the same with the GET answering in another shape — no DELETE, the old roles and member kept.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { keepMember, membersOf, productRoles, readServer, saveServer, setProductRoles, startTrip } from "@/lib/discord-store";
import { GET as returnDiscord } from "@/app/api/discord/callback/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OLD = "100000000000000001";
const NEW = "100000000000000002";
const ROLE = "200000000000000001";
const ANA = "300000000000000001";
const OWNER = "sweep-app4-discord@example.com";
const discord: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "discord.com") {
    const path = url.pathname.replace("/api/v10", "");
    discord.push(`${method} ${path}`);
    if (path === "/oauth2/token") return new Response(JSON.stringify({ access_token: "tok", guild: { id: NEW, name: "New server" } }), { status: 200 });
    if (method === "DELETE") return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Commands = (string | number)[][];

async function scenario(unknownServerRead: boolean) {
  redis.clear();
  discord.length = 0;
  process.env.DISCORD_CLIENT_ID = "400000000000000001";
  process.env.DISCORD_CLIENT_SECRET = "secret";
  process.env.DISCORD_BOT_TOKEN = "bot";
  process.env.STRIPE_SECRET_KEY = "sk_test_sweep_app4_discord";
  await claimHandle(OWNER, "app4-discord-shop", "App4 Discord Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_App4Discord1", subscriptionId: "sub_App4Discord1", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  await saveServer(room, { id: OLD, name: "Old server", at: 1, kick: false });
  await setProductRoles(room, "prod1", [ROLE]);
  await keepMember(room, store.sid, ANA, { e: "ana@example.com", n: "Ana", p: ["prod1"], r: [ROLE], at: 1, checked: 1 });
  const session = await openSession(OWNER);
  const redirect = "https://marktmorgen.com/api/discord/callback";
  const state = await startTrip({ k: "install", sid: store.sid, by: OWNER, redirect });

  const real = redis.pipeline.bind(redis);
  let used = false;
  if (unknownServerRead) {
    redis.pipeline = (async (commands: Commands) => {
      if (!used && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:dc:srv:")) {
        used = true;
        return [];
      }
      return real(commands);
    }) as typeof redis.pipeline;
  }
  let location = "";
  let thrown = "";
  try {
    const response = await returnDiscord(new NextRequest(`${redirect}?state=${state}&code=synthetic_install_code`, { headers: { host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` } }));
    location = new URL(response.headers.get("location") ?? "https://none.invalid/").searchParams.get("discord") ?? "";
  } catch (error) {
    // next/server's after() outside a request: thrown only after the server was saved, past every step shown here.
    thrown = error instanceof Error ? error.message.slice(0, 40) : "thrown";
  } finally {
    redis.pipeline = real;
  }
  return {
    reached: location === "connected" || thrown !== "",
    server: (await readServer(room))?.id ?? null,
    left: discord.includes(`DELETE /users/@me/guilds/${OLD}`),
    roles: [...(await productRoles(room)).entries()],
    members: (await membersOf(room)).map((m) => m.id),
  };
}

async function main() {
  part("1. Healthy control: the server read answers; switching to a new server forgets and leaves the old one");
  const healthy = await scenario(false);
  is("healthy: the callback went through to the new server", [healthy.reached, healthy.server], [true, NEW]);
  is("healthy: the bot left the old server", healthy.left, true);
  is("healthy: the old server's product roles and members forgotten", [healthy.roles, healthy.members], [[], []]);

  part("1. DEFECT: the same, the GET of the kept server answering in another shape");
  const defect = await scenario(true);
  is("DEFECT: the callback still went through to the new server", [defect.reached, defect.server], [true, NEW]);
  is("DEFECT: the bot never left the old server (no DELETE sent)", defect.left, false);
  is("DEFECT: the old server's product roles and member (with the buyer's address) kept, now read against the new server", [defect.roles, defect.members], [[["prod1", [ROLE]]], [ANA]]);

  done();
}

void main();
