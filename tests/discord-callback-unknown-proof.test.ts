import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, addProduct } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { keepMember, productRoles, readMember, readServer, saveServer, setProductRoles, startTrip } from "@/lib/discord-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET as returnDiscord } from "@/app/api/discord/callback/route";
const OLD = "100000000000000021", NEW = "100000000000000022", R1 = "200000000000000021", ANA = "300000000000000021";
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input)); const method = init?.method ?? "GET";
  const path = url.pathname.replace("/api/v10", ""); calls.push(`${method} ${path}`);
  if (path === "/oauth2/token") return new Response(JSON.stringify({ access_token: "tok", guild: { id: NEW, name: "New" } }), { status: 200 });
  if (path.startsWith("/users/@me/guilds/")) return new Response(null, { status: 204 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;
async function main() {
  redis.clear();
  Object.assign(process.env, { STRIPE_SECRET_KEY: "sk_test_x", DISCORD_CLIENT_ID: "400000000000000021", DISCORD_CLIENT_SECRET: "s", DISCORD_BOT_TOKEN: "b" });
  const O = "proof-owner@example.com";
  await claimHandle(O, "proofclub", "Proof", ""); await ensureStatsId(O); await ensureStoreId(O);
  await setStripeAccount(O, "acct_1TestProof00001", true);
  await setSubscription(O, { customerId: "cus_Proof000001", subscriptionId: "sub_Proof000001", active: true, period: paidPeriod() });
  const made = await addProduct(O, "P", "", "20", null); if (!made.ok) throw new Error("x");
  const store = (await storeForEmail(O))!; const room = storeKey(store);
  for (const odd of [42, "{", ["x"]] as unknown[]) {
    redis.clear();
    await claimHandle(O, "proofclub", "Proof", ""); await ensureStatsId(O); await ensureStoreId(O);
    await setSubscription(O, { customerId: "cus_Proof000001", subscriptionId: "sub_Proof000001", active: true, period: paidPeriod() });
    const s = (await storeForEmail(O))!; const rm = storeKey(s);
    await saveServer(rm, { id: OLD, name: "Old", at: 1, kick: true });
    await setProductRoles(rm, made.product.id, [R1]);
    await keepMember(rm, s.sid, ANA, { e: "ana@example.com", n: "Ana", p: [made.product.id], r: [R1], at: 1, checked: 1 });
    const session = await openSession(O);
    const redirect = "https://marktmorgen.com/api/discord/callback";
    const trip = await startTrip({ k: "install", sid: s.sid, by: O, redirect });
    const real = redis.pipeline.bind(redis); let once = true;
    (redis as unknown as { pipeline: typeof real }).pipeline = async (cmds) => {
      if (once && cmds.length === 1 && cmds[0][0] === "GET" && String(cmds[0][1]).startsWith("nl:dc:srv:")) { once = false; return [odd] as never; }
      return real(cmds);
    };
    calls.length = 0;
    let to = "threw-after-writes"; try { const res = await returnDiscord(new NextRequest(`${redirect}?state=${trip}&code=c1`, { headers: { host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` } }));
    to = new URL(res.headers.get("location")!).searchParams.get("discord") ?? ""; } catch (e) { to = "threw: " + String(e).slice(0, 60); }
    (redis as unknown as { pipeline: typeof real }).pipeline = real;
    part(`GET srv answered ${JSON.stringify(odd)}`);
    console.log("  route ended:", to);
    is("old server left by the bot?", calls.includes(`DELETE /users/@me/guilds/${OLD}`), false);
    is("saved server now NEW", (await readServer(rm))?.id, NEW);
    is("old server's product roles kept on the new server", [...(await productRoles(rm)).values()], [[R1]]);
    is("old server's member still kept", (await readMember(rm, ANA))?.r, [R1]);
  }
  void room; done();
}
main();
