/**
 * Sweep app1 proof (CX-123 rule 24), synthetic only. "Disconnect Discord", app/api/store/discord/route.ts:76-80:
 *   const people = await forgetServer(room, store.sid);
 *   await leaveServer(server.id).catch(() => false);
 *   return Response.json({ ok: true, people });
 * The server record, the product roles and the member list are deleted first; then the bot is asked to leave the
 * creator's server and its answer (false on any failure, lib/discord.ts:207-210) is dropped. When Discord does not
 * answer, the creator is told it is disconnected while the bot is still in their server with the role-managing,
 * inviting and removing permissions it was installed with, and the studio no longer knows the server, so it cannot
 * be retried from here. Discord is a stand-in for `fetch`; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readServer, saveServer } from "@/lib/discord-store";
import { storeKey } from "@/lib/learn";
import { POST as manageDiscord } from "@/app/api/store/discord/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.DISCORD_CLIENT_ID = "400000000000000001";
process.env.DISCORD_CLIENT_SECRET = "secret";
process.env.DISCORD_BOT_TOKEN = "bot";

const SERVER = "100000000000000001";
const asked: string[] = [];
let discordDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  asked.push(`${init?.method ?? "GET"} ${url.pathname.replace(/^\/api\/v10/, "")}`);
  if (discordDown) return new Response(JSON.stringify({ message: "synthetic outage" }), { status: 503 });
  return new Response(null, { status: 204 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "discord-sweep@example.com";
  await claimHandle(OWNER, "discordsweep", "Discord Sweep", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestDiscSweep1", true);
  await setSubscription(OWNER, { customerId: "cus_DiscSweep01", subscriptionId: "sub_DiscSweep01", active: true, period: paidPeriod() });
  await addProduct(OWNER, "The Club", "", "20", null);
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  const session = await openSession(OWNER);
  const manage = async (body: Record<string, unknown>) => {
    const response = await manageDiscord(new NextRequest(`https://marktmorgen.com/api/store/discord?store=${store.sid}`, { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };

  part("Healthy control: Discord answers, the bot leaves and the server is forgotten");
  await saveServer(room, { id: SERVER, name: "The Club", at: 1, kick: false });
  const ok = await manage({ action: "disconnect" });
  is("ok, the bot asked to leave, the record gone", [ok.status, ok.body.ok, asked.includes(`DELETE /users/@me/guilds/${SERVER}`), await readServer(room)], [200, true, true, null]);

  part("DEFECT: Discord does not answer the leave");
  await saveServer(room, { id: SERVER, name: "The Club", at: 1, kick: false });
  asked.length = 0;
  discordDown = true;
  const told = await manage({ action: "disconnect" });
  discordDown = false;
  is("the leave was asked and failed (the bot is still in the server)", asked.filter((a) => a === `DELETE /users/@me/guilds/${SERVER}`).length >= 1, true);
  is("DEFECT: the creator is told it is disconnected", [told.status, told.body.ok], [200, true]);
  is("DEFECT: and the server is forgotten, so the studio cannot try again", await readServer(room), null);
  is("DEFECT: a second press says it is not connected", (await manage({ action: "disconnect" })).body.error, "not_connected");
  done();
}
main();
