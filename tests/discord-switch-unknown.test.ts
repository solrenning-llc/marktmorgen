/**
 * Switching the connected Discord server on an unknown Redis read (sweep APP4 finding 2, CX-123 rules 24/30).
 * Synthetic only: Redis is the in-memory stand-in, Discord a stand-in fetch (no network).
 *
 * Before the fix, app/api/discord/callback/route.ts read the server kept so far with `readServer(room)`, which takes
 * a GET answering in another shape as "no server connected". On that, a creator adding the bot to a NEW server had
 * the new id written over the old one while the old server was never forgotten nor left: its product roles and
 * member records (with the buyers' addresses) stayed on the store, now read against the new server, the bot stayed
 * in the old server where nothing checks the roles it gave, and the creator was told "connected".
 *
 * What is checked:
 *   - healthy: switching forgets and leaves the old server and keeps the new one;
 *   - nothing kept (the exact null reply): the new server is connected as before, nothing to leave;
 *   - an unknown read of the kept server (another shape, or a thrown read): nothing switches, the code is not
 *     exchanged, the old server stays connected with its roles and members, the bot is not removed from it, and the
 *     creator is sent back with `discord=unchecked`, never `discord=connected`;
 *   - forgetting the old server fails (a thrown read of its members, as #3017's exact forgetServer throws on an
 *     unknown reply): the creator is sent back with `discord=unchecked`, never a bare 500; the new server is not
 *     saved, the old one stays connected with its roles and members, and the bot is not removed from it (LOW of the
 *     independent review on #2976);
 *   - the studio page has an honest, plain words notice for `unchecked`, shown as an error (role="alert").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { keepMember, membersOf, productRoles, readServer, saveServer, setProductRoles, startTrip } from "@/lib/discord-store";
import { GET as returnDiscord } from "@/app/api/discord/callback/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OLD = "100000000000000011";
const NEW = "100000000000000012";
const ROLE = "200000000000000011";
const ANA = "300000000000000011";
const OWNER = "discord-switch-unknown@example.com";
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
type Read = "healthy" | "none" | "shape" | "thrown" | "forget";

async function scenario(read: Read) {
  redis.clear();
  discord.length = 0;
  process.env.DISCORD_CLIENT_ID = "400000000000000011";
  process.env.DISCORD_CLIENT_SECRET = "secret";
  process.env.DISCORD_BOT_TOKEN = "bot";
  process.env.STRIPE_SECRET_KEY = "sk_test_discord_switch_unknown";
  await claimHandle(OWNER, "discord-switch-shop", "Discord Switch Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_DcSwitch1", subscriptionId: "sub_DcSwitch1", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  if (read !== "none") {
    await saveServer(room, { id: OLD, name: "Old server", at: 1, kick: false });
    await setProductRoles(room, "prod1", [ROLE]);
    await keepMember(room, store.sid, ANA, { e: "ana@example.com", n: "Ana", p: ["prod1"], r: [ROLE], at: 1, checked: 1 });
  }
  const session = await openSession(OWNER);
  const redirect = "https://marktmorgen.com/api/discord/callback";
  const state = await startTrip({ k: "install", sid: store.sid, by: OWNER, redirect });

  const real = redis.pipeline.bind(redis);
  let used = false;
  if (read === "shape" || read === "thrown") {
    redis.pipeline = (async (commands: Commands) => {
      if (!used && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:dc:srv:")) {
        used = true;
        if (read === "thrown") throw new Error("synthetic Redis failure");
        return [];
      }
      return real(commands);
    }) as typeof redis.pipeline;
  }
  if (read === "forget") {
    // The switch's first read of the old server's members fails (forgetServer), after the kept server read exactly.
    redis.pipeline = (async (commands: Commands) => {
      if (!used && commands.length === 1 && commands[0][0] === "HKEYS" && String(commands[0][1]).startsWith("nl:dc:mem:")) {
        used = true;
        throw new Error("synthetic Redis failure");
      }
      return real(commands);
    }) as typeof redis.pipeline;
  }
  let status = "";
  let thrown = "";
  try {
    const response = await returnDiscord(new NextRequest(`${redirect}?state=${state}&code=synthetic_install_code`, { headers: { host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` } }));
    status = new URL(response.headers.get("location") ?? "https://none.invalid/").searchParams.get("discord") ?? "";
  } catch (error) {
    // next/server's after() outside a request: thrown only after the server was saved, on the way to "connected".
    thrown = error instanceof Error ? error.message : String(error);
  } finally {
    redis.pipeline = real;
  }
  return {
    status: status || (thrown.includes("`after` was called outside a request scope") ? "connected" : `thrown: ${thrown}`),
    server: (await readServer(room))?.id ?? null,
    exchanged: discord.includes("POST /oauth2/token"),
    left: discord.includes(`DELETE /users/@me/guilds/${OLD}`),
    roles: [...(await productRoles(room)).entries()],
    members: (await membersOf(room)).map((m) => m.id),
  };
}

async function main() {
  part("1. Healthy: switching to a new server forgets and leaves the old one");
  const healthy = await scenario("healthy");
  is("healthy: connected to the new server", [healthy.status, healthy.server], ["connected", NEW]);
  is("healthy: the bot left the old server", healthy.left, true);
  is("healthy: the old server's roles and members forgotten", [healthy.roles, healthy.members], [[], []]);

  part("2. Nothing kept (the exact null): the new server is connected, nothing to leave");
  const none = await scenario("none");
  is("none: connected to the new server", [none.status, none.server], ["connected", NEW]);
  is("none: no server left", none.left, false);

  for (const read of ["shape", "thrown"] as const) {
    part(`3. The kept server read unknown (${read === "shape" ? "a reply of another shape" : "a thrown read"}): nothing switches`);
    const unknown = await scenario(read);
    is(`${read}: the creator is told the server could not be checked, never "connected"`, unknown.status, "unchecked");
    is(`${read}: the old server is still the one connected`, unknown.server, OLD);
    is(`${read}: the code was not exchanged and the bot not removed from the old server`, [unknown.exchanged, unknown.left], [false, false]);
    is(`${read}: the old server's roles and member kept, on the old server`, [unknown.roles, unknown.members], [[["prod1", [ROLE]]], [ANA]]);
  }

  part("4. Forgetting the old server fails: nothing switches, and the creator is told so, never a bare 500");
  const forget = await scenario("forget");
  is("forget: the creator is told the server could not be checked, never a bare 500 or \"connected\"", forget.status, "unchecked");
  is("forget: the new server was not saved; the old one is still connected", forget.server, OLD);
  is("forget: the bot was not removed from the old server", forget.left, false);
  is("forget: the old server's roles and member kept", [forget.roles, forget.members], [[["prod1", [ROLE]]], [ANA]]);

  part("5. The studio says so plainly, as an error");
  const page = readFileSync(join(process.cwd(), "app/studio/discord/page.tsx"), "utf8");
  const line = page.split("\n").find((l) => /^\s*unchecked:/.test(l)) ?? "";
  is("the notice for unchecked is an error", /tone: "error"/.test(line), true);
  is("the notice says nothing was changed and to try again", /could not check[^"]*Nothing was changed; try again/.test(line), true);

  done();
}

void main();
