/**
 * Sweep app1, finding 8: "Disconnect the server" in the studio
 * (app/api/store/discord/route.ts). The creator hears "Disconnected" only once
 * Discord confirmed the bot left (an exact answer: 2xx, or 404 with code 10004 when it was no
 * longer there); before that nothing kept for the server is forgotten, so a
 * failed leave answers an honest error ("server", 502) and the creator can
 * press again. And the connected server read in another shape is not "no
 * server": every action answers "unavailable" (503) with nothing changed,
 * never "No server is connected any more" (CX-123 rule 24; the sibling noted
 * on PR #2976). Discord is a stand-in for `fetch`, Redis the memory stand-in;
 * nothing real is reached.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { productRoles, readServer, saveServer, setProductRoles } from "@/lib/discord-store";
import { storeKey } from "@/lib/learn";
import { POST as manageDiscord } from "@/app/api/store/discord/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.DISCORD_CLIENT_ID = "400000000000000001";
process.env.DISCORD_CLIENT_SECRET = "secret";
process.env.DISCORD_BOT_TOKEN = "bot";

const SERVER = "100000000000000001";
const ROLE = "200000000000000001";
const LEAVE = `DELETE /users/@me/guilds/${SERVER}`;
const asked: string[] = [];
let leave: "left" | "ok200" | "gone" | "down" | "throws" | "forbidden" | "bare404" | "other404" = "left";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const what = `${init?.method ?? "GET"} ${url.pathname.replace(/^\/api\/v10/, "")}`;
  asked.push(what);
  if (what === LEAVE) {
    if (leave === "throws") throw new TypeError("synthetic network failure");
    if (leave === "down") return new Response(JSON.stringify({ message: "synthetic outage" }), { status: 503 });
    if (leave === "forbidden") return new Response(JSON.stringify({ message: "Missing Access", code: 50001 }), { status: 403 });
    // A 404 that is not Discord's "Unknown Guild" (10004), such as a proxy's HTML page or another code, does not
    // say the bot is out (independent review of #2994, comment 6698105767).
    if (leave === "bare404") return new Response("<html><body>404 Not Found</body></html>", { status: 404, headers: { "content-type": "text/html" } });
    if (leave === "other404") return new Response(JSON.stringify({ message: "404: Not Found", code: 0 }), { status: 404 });
    if (leave === "gone") return new Response(JSON.stringify({ message: "Unknown Guild", code: 10004 }), { status: 404 });
    if (leave === "ok200") return new Response(null, { status: 200 });
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ message: `no stand-in for ${what}` }), { status: 404 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
let bend: "real" | "lost" | "text" | "list" | "broken" = "real";
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await real(commands);
  const isServerRead = commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:dc:srv:");
  if (bend === "real" || !isServerRead) return replies;
  if (bend === "lost") return [];
  if (bend === "text") return ["QUEUED"];
  if (bend === "list") return [[replies[0]]];
  return ["{not json"];
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "discord-route-unknown@example.com";
  await claimHandle(OWNER, "discordunknown", "Discord Unknown", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestDiscUnkn01", true);
  await setSubscription(OWNER, { customerId: "cus_DiscUnkn01", subscriptionId: "sub_DiscUnkn01", active: true, period: paidPeriod() });
  const product = await addProduct(OWNER, "The Club", "", "20", null);
  if (!product.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  const session = await openSession(OWNER);
  const manage = async (body: Record<string, unknown>) => {
    const response = await manageDiscord(new NextRequest(`https://marktmorgen.com/api/store/discord?store=${store.sid}`, { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; people?: number } };
  };
  const connect = async () => {
    await saveServer(room, { id: SERVER, name: "The Club", at: 1, kick: false });
    await setProductRoles(room, product.product.id, [ROLE]);
  };
  const kept = async () => [(await readServer(room))?.id ?? null, (await productRoles(room)).get(product.product.id) ?? []];

  part("Healthy control: Discord confirms the leave, then everything kept is forgotten");
  for (const [label, as] of [["204", "left"], ["200", "ok200"], ["404, the bot was no longer there", "gone"]] as const) {
    await connect();
    asked.length = 0;
    leave = as;
    const ok = await manage({ action: "disconnect" });
    leave = "left";
    is(`${label}: told it is disconnected, after the leave was asked`, [ok.status, ok.body.ok, asked.includes(LEAVE)], [200, true, true]);
    is(`${label}: the server and its product roles are forgotten`, await kept(), [null, []]);
  }

  for (const [label, as] of [["Discord answers 503", "down"], ["the request to Discord fails", "throws"], ["Discord answers 403", "forbidden"], ["an HTML 404 with no Discord code", "bare404"], ["a 404 with a code other than 10004", "other404"]] as const) {
    part(`The leave is not confirmed: ${label}`);
    await connect();
    asked.length = 0;
    leave = as;
    const told = await manage({ action: "disconnect" });
    leave = "left";
    is(`${label}: the leave was asked`, asked.includes(LEAVE), true);
    is(`${label}: never told it is disconnected; an honest "server" error (502)`, [told.status, told.body.ok, told.body.error], [502, false, "server"]);
    is(`${label}: the server and its product roles are kept`, await kept(), [SERVER, [ROLE]]);
    const again = await manage({ action: "disconnect" });
    is(`${label}: pressing again once Discord answers disconnects`, [again.status, again.body.ok], [200, true]);
    is(`${label}: and only then is everything forgotten`, await kept(), [null, []]);
  }

  part("The connected server read in another shape is not \"no server\"");
  await connect();
  for (const as of ["lost", "text", "list", "broken"] as const) {
    for (const body of [{ action: "disconnect" }, { action: "kick", on: true }, { action: "roles", productId: product.product.id, roles: [] }]) {
      asked.length = 0;
      bend = as;
      const answer = await manage(body);
      bend = "real";
      is(`${as}, ${body.action}: 503 unavailable, never "not_connected"`, [answer.status, answer.body.ok, answer.body.error], [503, false, "unavailable"]);
      is(`${as}, ${body.action}: Discord was not asked`, asked.length, 0);
    }
  }
  is("the server, its setting and its product roles are unchanged", [(await readServer(room))?.kick, ...(await kept())], [false, SERVER, [ROLE]]);

  part("No server kept is still \"not connected\"");
  await manage({ action: "disconnect" });
  is("a store with no server: not_connected (409)", Object.values(await manage({ action: "disconnect" })).map((v) => (typeof v === "object" ? v.error : v)), [409, "not_connected"]);

  part("The studio says it honestly");
  const studio = readFileSync("components/discord-studio.tsx", "utf8");
  is("the studio has words for \"unavailable\": nothing was changed, try again", /unavailable: "[^"]*Nothing was changed[^"]*try again/i.test(studio), true);
  done();
}
main();
