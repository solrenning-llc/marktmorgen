/**
 * The connected Discord server is never written back for a store whose erasure began or ended while the write was
 * on its way (Codex L-20261120-0732, MEDIUM). The callback (app/api/discord/callback/route.ts) reads the store and
 * the creator's permission, then waits on Discord's OAuth exchange; the studio's "kick" option
 * (app/api/store/discord/route.ts) reads the kept server first. Both then wrote `nl:dc:srv:<room>` with a plain SET,
 * no expiry and no look at the store: an erasure that passed meanwhile got the server's id, name and setting back
 * after its walk, and the creator was told "connected" (or ok). Now the write is one step fenced on the store being
 * live (lib/live-fence.ts's rule): its erasing mark absent and its id key still holding this very store's ref.
 *
 * What is checked, through the real routes and the real writer, synthetic data only (Discord is a stand-in fetch,
 * Redis the in-memory stand-in):
 *   - erased (closeStoreRecord, the walk's last step) while the code is exchanged: no server kept, and the creator
 *     is told the outcome is unknown ("unconfirmed"), never "connected", and the connected notice is never queued;
 *   - its erasing mark set while the code is exchanged: the same;
 *   - an answer of the fenced step that does not read (rule 24): "unconfirmed", nothing written, no plain SET after;
 *   - the kick option, erased (or marked) between its read and its write: 503, nothing written back;
 *   - control: a live store is connected and its kick option kept, as before, at the EVAL and its three calls.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { ERASING_KEY, claimHandle, closeStoreRecord, ensureStatsId, ensureStoreId, erasingField, setSubscription, storeForEmail, storeRef, type Store } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { startTrip } from "@/lib/discord-store";
import { GET as returnDiscord } from "@/app/api/discord/callback/route";
import { POST as manageDiscord } from "@/app/api/store/discord/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SERVER = "100000000000000021";
const OWNER = "discord-erasure@example.test";
const REDIRECT = "https://marktmorgen.com/api/discord/callback";
type Command = (string | number)[];

process.env.DISCORD_CLIENT_ID = "400000000000000021";
process.env.DISCORD_CLIENT_SECRET = "synthetic-discord-secret";
process.env.DISCORD_BOT_TOKEN = "synthetic-discord-bot";
process.env.STRIPE_SECRET_KEY = "sk_test_discord_server_erasure";

/** Something to run while Discord's code exchange is awaited. */
let duringExchange: (() => Promise<void>) | null = null;
const discord: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "discord.com") throw new Error(`no network in this test: ${String(input)}`);
  const method = init?.method ?? "GET";
  const path = url.pathname.replace("/api/v10", "");
  discord.push(`${method} ${path}`);
  if (path === "/oauth2/token") {
    const run = duringExchange;
    duringExchange = null;
    if (run) await run();
    return new Response(JSON.stringify({ access_token: "synthetic-token", guild: { id: SERVER, name: "Synthetic server" } }), { status: 200 });
  }
  return new Response(null, { status: 204 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** Whether a batch writes the store's server: a plain SET of it, or an EVAL naming it among its keys. */
const writesServer = (commands: Command[], target: string) =>
  commands.some((c) => (c[0] === "SET" && c[1] === target) || (c[0] === "EVAL" && c.slice(3, 3 + Number(c[2])).includes(target)));
/** Something to run right before the server's write reaches Redis, or a reply to put in place of it. */
const hook: { before: (() => Promise<void>) | null; reply: unknown[] | null; target: string } = { before: null, reply: null, target: "" };
let charge = 0;
redis.pipeline = (async (commands: Command[]) => {
  if (hook.target && writesServer(commands, hook.target)) {
    const run = hook.before;
    hook.before = null;
    if (run) await run();
    if (hook.reply) return hook.reply;
    const calls = redis.scriptCalls;
    const answer = await real(commands);
    charge += commands.length + redis.scriptCalls - calls;
    return answer;
  }
  return real(commands);
}) as typeof redis.pipeline;

async function world(): Promise<{ store: Store; session: string; target: string }> {
  redis.clear();
  discord.length = 0;
  hook.before = null;
  hook.reply = null;
  charge = 0;
  await claimHandle(OWNER, "discord-erasure-shop", "Discord Erasure Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_DcErase1", subscriptionId: "sub_DcErase1", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const target = `nl:dc:srv:${storeKey(store)}`;
  hook.target = target;
  return { store, session: await openSession(OWNER), target };
}

async function mark(store: Store): Promise<void> {
  await real([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]);
}

/** The callback's answer: its `discord=` word, or "connected" when after() was reached outside a request scope. */
async function callback(session: string, store: Store): Promise<{ status: string; noticed: boolean }> {
  const state = await startTrip({ k: "install", sid: store.sid, by: OWNER, redirect: REDIRECT });
  try {
    const response = await returnDiscord(new NextRequest(`${REDIRECT}?state=${state}&code=synthetic_install_code`, { headers: { host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` } }));
    return { status: new URL(response.headers.get("location") ?? "https://none.invalid/").searchParams.get("discord") ?? "", noticed: false };
  } catch (error) {
    // next/server's after() outside a request: reached only on the way to "connected", once the server was saved.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("`after` was called outside a request scope")) return { status: "connected", noticed: true };
    return { status: `thrown: ${message}`, noticed: false };
  }
}

async function kick(session: string, on: boolean): Promise<{ status: number; body: unknown }> {
  const response = await manageDiscord(new NextRequest("https://marktmorgen.com/api/store/discord", {
    method: "POST",
    headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
    body: JSON.stringify({ action: "kick", on }),
  }));
  return { status: response.status, body: await response.json() };
}

const kept = async (target: string) => (await real([["GET", target]]))[0];

async function main(): Promise<void> {
  part("Control: a live store is connected, and its kick option kept");
  {
    const w = await world();
    const back = await callback(w.session, w.store);
    is("connected, with its notice", back, { status: "connected", noticed: true });
    is("the server is kept", JSON.parse(String(await kept(w.target))).id, SERVER);
    is("the write is billed as the EVAL and its three calls (HGET, GET, SET)", charge, 4);
    const turned = await kick(w.session, true);
    is("kick: ok", [turned.status, turned.body], [200, { ok: true }]);
    is("kick: the option is kept on the same server", [JSON.parse(String(await kept(w.target))).kick, JSON.parse(String(await kept(w.target))).id], [true, SERVER]);
  }

  for (const phase of ["erased", "erasing"] as const) {
    part(`The store ${phase === "erased" ? "erased" : "marked for erasure"} while Discord's code is exchanged: nothing comes back`);
    const w = await world();
    duringExchange = async () => {
      await real([["DEL", w.target]]);
      if (phase === "erased") is("the store's record went with its erasure", await closeStoreRecord(w.store), true);
      else await mark(w.store);
    };
    const back = await callback(w.session, w.store);
    is("the code was exchanged with the stand-in", discord.includes("POST /oauth2/token"), true);
    is("no server kept for the erased store", await kept(w.target), null);
    is("the creator is told the outcome is unknown, never \"connected\", and no connected notice is queued", back, { status: "unconfirmed", noticed: false });
  }

  part("The fenced step's answer does not read (rule 24): unknown, never connected, no plain SET after it");
  {
    const w = await world();
    hook.reply = [];
    const back = await callback(w.session, w.store);
    is("unconfirmed, no notice", back, { status: "unconfirmed", noticed: false });
    is("nothing written", await kept(w.target), null);
  }

  for (const phase of ["erased", "erasing"] as const) {
    part(`Kick option: the store ${phase === "erased" ? "erased" : "marked for erasure"} between its read and its write`);
    const w = await world();
    await real([["SET", w.target, JSON.stringify({ id: SERVER, name: "Synthetic server", at: 1, kick: false })]]);
    hook.before = async () => {
      await real([["DEL", w.target]]);
      if (phase === "erased") await closeStoreRecord(w.store);
      else await mark(w.store);
    };
    const turned = await kick(w.session, true);
    is("503, never ok", [turned.status, turned.body], [503, { ok: false, error: "unavailable" }]);
    is("nothing written back", await kept(w.target), null);
  }

  done();
}

void main();
