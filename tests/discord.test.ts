/**
 * Discord access (lib/discord-access.ts, added 11 October 2026). What is
 * checked:
 *
 *   - the rules: roles cleaned and capped, only roles the bot can give
 *     offered, what to add and take worked out from what was given;
 *   - Discord's page is asked only for what each side needs;
 *   - a buyer who holds a product is put in the server with its roles, and
 *     one who holds nothing is not;
 *   - one Discord account per address: a second one takes the roles over;
 *   - checking again keeps what is held, adds what a product gives since,
 *     and takes everything back once nothing is held, removing the person
 *     from the server only when the creator asked for it;
 *   - Stripe that cannot be asked takes nothing from anybody;
 *   - a trip to Discord's page is used once, and people are due every few hours.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { CHECK_HOURS, KICK_TRIES, MAX_PRODUCT_ROLES, assignable, cleanRoles, rolesDiff, rolesFor } from "@/lib/discord-rules";
import { authorizeUrl } from "@/lib/discord";
import { checkMember, joinServer } from "@/lib/discord-access";
import { accountOf, dueMembers, readMember, readServer, saveServer, setProductRoles, startTrip, takeTrip } from "@/lib/discord-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET as returnDiscord } from "@/app/api/discord/callback/route";
import { POST as startDiscordInstall } from "@/app/api/store/discord/connect/route";
import { POST as manageDiscord } from "@/app/api/store/discord/route";
import { allowanceUsed } from "@/lib/store-allowance";

const SERVER = "100000000000000001";
const R1 = "200000000000000001";
const R2 = "200000000000000002";
const ANA = "300000000000000001";
const ANA_TWO = "300000000000000002";

let stripe: "active" | "canceled" | "down" = "active";
let handle = "";
let productId = "";
const discord: string[] = [];
const members = new Set<string>();
// When true, Discord answers a removal from the server with an error, as when the bot lost "Kick Members".
let kickFails = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "discord.com") {
    const path = url.pathname.replace("/api/v10", "");
    discord.push(`${method} ${path}`);
    const member = path.match(/^\/guilds\/\d+\/members\/(\d+)$/);
    if (member && method === "PUT") {
      const fresh = !members.has(member[1]);
      members.add(member[1]);
      return new Response(fresh ? "{}" : null, { status: fresh ? 201 : 204 });
    }
    if (member && method === "DELETE") {
      if (kickFails) return json({ message: "Missing Permissions", code: 50013 }, 403);
      members.delete(member[1]);
      return new Response(null, { status: 204 });
    }
    if (/^\/guilds\/\d+\/members\/\d+\/roles\/\d+$/.test(path)) return new Response(null, { status: 204 });
    return json({ message: "no stand-in" }, 404);
  }
  // The creator's Stripe account: one membership, bought by Ana.
  const path = url.pathname.replace(/^\/v1/, "");
  if (stripe === "down") return json({ error: { message: "down" } }, 500);
  if (path === "/checkout/sessions" && url.searchParams.get("customer_details[email]") === "ana@example.com") {
    return json({
      object: "list",
      data: [
        {
          id: "cs_test_ana",
          status: "complete",
          payment_status: "paid",
          mode: "subscription",
          customer: "cus_Ana0000001",
          metadata: { store: handle, product: productId },
          subscription: { id: "sub_Ana0000001", status: stripe },
          payment_intent: null,
        },
      ],
      has_more: false,
    });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_discord_only_a_stand_in";
  process.env.DISCORD_CLIENT_ID = "400000000000000001";
  process.env.DISCORD_CLIENT_SECRET = "secret";
  process.env.DISCORD_BOT_TOKEN = "bot";

  part("The rules");
  is("roles are ids, once each, three at most", cleanRoles([R1, R1, "x", R2, "200000000000000003", "200000000000000004"]), [R1, R2, "200000000000000003"].slice(0, MAX_PRODUCT_ROLES));
  const roles = [
    { id: SERVER, name: "@everyone", color: 0, position: 0, managed: false },
    { id: R1, name: "Members", color: 0, position: 2, managed: false },
    { id: R2, name: "Moderators", color: 0, position: 9, managed: false },
    { id: "200000000000000005", name: "Some bot", color: 0, position: 1, managed: true },
  ];
  is("only roles the bot can give: below its own, not everyone's, not an app's", assignable(roles, SERVER, 5).map((r) => r.name), ["Members"]);
  is("what to add and what to take", rolesDiff([R1], [R2]), { add: [R2], take: [R1] });
  is("the roles of what is held", rolesFor(["a", "b"], new Map([["a", [R1]], ["b", [R1, R2]]])), [R1, R2]);

  part("Discord's page asks each side only for what it needs");
  const install = new URL(authorizeUrl("install", "s", "https://marktmorgen.com/api/discord/callback"));
  const join = new URL(authorizeUrl("join", "s", "https://marktmorgen.com/api/discord/callback"));
  is("the creator adds a bot that manages roles, invites and removes people, and nothing else", [install.searchParams.get("scope"), install.searchParams.get("permissions")], ["identify bot", "268435459"]);
  is("the buyer lets it see who they are and put them in a server", join.searchParams.get("scope"), "identify guilds.join");

  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "clubhouse", "Clubhouse", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestClubhouse1", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "The Club", "", "20", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  let store = (await storeForEmail(OWNER))!;
  handle = store.handle;
  const room = storeKey(store);
  await saveServer(room, { id: SERVER, name: "The Club", at: 1, kick: false });
  await setProductRoles(room, productId, [R1]);

  part("Joining");
  const nobody = await joinServer({ store, email: "bo@example.com", accessToken: "t", user: { id: "300000000000000009", name: "Bo" } });
  is("somebody who holds nothing is not let in", nobody.ok ? "in" : nobody.reason, "none");
  is("and Discord is not asked to", discord.filter((c) => c.startsWith("PUT")).length, 0);
  const ana = await joinServer({ store, email: "ana@example.com", accessToken: "t", user: { id: ANA, name: "Ana" } });
  is("a member is put in the server with the product's roles", ana.ok && [ana.added, ana.roles], [true, 1]);
  is("and kept, with what was given", (await readMember(room, ANA))?.r, [R1]);
  discord.length = 0;
  const again = await joinServer({ store, email: "ana@example.com", accessToken: "t", user: { id: ANA_TWO, name: "Ana's other" } });
  is("a second Discord account for the same address takes the roles over", [again.ok, discord.includes(`DELETE /guilds/${SERVER}/members/${ANA}/roles/${R1}`), await readMember(room, ANA), await accountOf(room, "ana@example.com")], [true, true, null, ANA_TWO]);

  part("Checking again");
  is("not due before its time", (await dueMembers(Date.now())).length, 0);
  is("due after it", (await dueMembers(Date.now() + CHECK_HOURS * 3_600_000 + 1000)).map((d) => d.userId), [ANA_TWO]);
  is("still a member: kept", await checkMember(store.sid, ANA_TWO), "kept");
  await setProductRoles(room, productId, [R1, R2]);
  discord.length = 0;
  is("a role the product gives since is added", [await checkMember(store.sid, ANA_TWO), discord], ["changed", [`PUT /guilds/${SERVER}/members/${ANA_TWO}/roles/${R2}`]]);

  stripe = "down";
  await redisFlushCache();
  discord.length = 0;
  is("Stripe cannot be asked: nothing is taken", [await checkMember(store.sid, ANA_TWO), discord], ["later", []]);

  stripe = "canceled";
  await redisFlushCache();
  discord.length = 0;
  is("the membership ended: every role given is taken back", [await checkMember(store.sid, ANA_TWO), discord.sort()], ["ended", [`DELETE /guilds/${SERVER}/members/${ANA_TWO}/roles/${R1}`, `DELETE /guilds/${SERVER}/members/${ANA_TWO}/roles/${R2}`]]);
  is("they stay in the server, and are forgotten", [members.has(ANA_TWO), await readMember(room, ANA_TWO)], [true, null]);

  part("Taken out of the server when the creator asks for it");
  stripe = "active";
  await redisFlushCache();
  store = (await storeForEmail(OWNER))!;
  await joinServer({ store, email: "ana@example.com", accessToken: "t", user: { id: ANA_TWO, name: "Ana" } });
  await saveServer(room, { id: SERVER, name: "The Club", at: 1, kick: true });
  stripe = "canceled";
  await redisFlushCache();
  kickFails = true;
  const notOut = await checkMember(store.sid, ANA_TWO);
  const kept = await readMember(room, ANA_TWO);
  is("Discord refusing the removal: kept to try again, never forgotten while still in the server", [notOut, members.has(ANA_TWO), kept?.r, kept?.p, kept?.k], ["later", true, [], [], 1]);
  const due = await dueMembers(Date.now() + CHECK_HOURS * 3_600_000 + 1_000);
  is("and back in line for the next check", due.some((d) => d.userId === ANA_TWO), true);
  discord.length = 0;
  kickFails = false;
  await redisFlushCache();
  is("at the next check: only the removal is tried, then it is forgotten", [await checkMember(store.sid, ANA_TWO), discord, members.has(ANA_TWO), await readMember(room, ANA_TWO)], ["ended", [`DELETE /guilds/${SERVER}/members/${ANA_TWO}`], false, null]);

  // A refusal that lasts: KICK_TRIES more checks, then forgotten as before, so it never keeps a check going.
  stripe = "active";
  await redisFlushCache();
  await joinServer({ store, email: "ana@example.com", accessToken: "t", user: { id: ANA_TWO, name: "Ana" } });
  stripe = "canceled";
  kickFails = true;
  const tries: string[] = [];
  for (let i = 0; i <= KICK_TRIES; i += 1) {
    await redisFlushCache();
    tries.push(await checkMember(store.sid, ANA_TWO));
  }
  is(`a lasting refusal: ${KICK_TRIES} tries kept, then forgotten`, [tries, await readMember(room, ANA_TWO)], [[...Array.from({ length: KICK_TRIES }, () => "later"), "ended"], null]);
  kickFails = false;

  part("A funded optional bot-install start refuses before provider consent");
  await claimHandle("funded-discord@example.com", "funded-discord-shop", "Funded Discord Shop", "");
  await ensureStatsId("funded-discord@example.com");
  await setSubscription("funded-discord@example.com", { customerId: "cus_DiscordFund01", subscriptionId: "sub_DiscordFund01", active: true, period: { ...paidPeriod(), funded: true } });
  const fundedDiscord = (await storeForEmail("funded-discord@example.com"))!;
  const installSession = await openSession("funded-discord@example.com");
  const beforeInstallUnits = await allowanceUsed(fundedDiscord, "integration");
  const beforeInstallRequests = discord.length;
  const installStart = await startDiscordInstall(new NextRequest(`https://marktmorgen.com/api/store/discord/connect?store=${fundedDiscord.sid}`, { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie: `${SESSION_COOKIE}=${installSession}` } }));
  const installDestination = new URL(installStart.headers.get("location") ?? "https://none.invalid/");
  is("the owner stays at the studio instead of Discord consent", [installStart.status, installDestination.hostname, installDestination.searchParams.get("discord")], [303, "marktmorgen.com", "limited"]);
  is("no provider request or extra integration allowance", [discord.length, await allowanceUsed(fundedDiscord, "integration")], [beforeInstallRequests, beforeInstallUnits]);


  part("A previously issued funded install trip is rechecked on return");
  const retainedServer={id:SERVER,name:"Retained synthetic server",at:1,kick:false};
  await saveServer(storeKey(fundedDiscord),retainedServer);
  const redirect="https://marktmorgen.com/api/discord/callback";
  const callbackFor=(state:string,query:string,session=installSession)=>returnDiscord(new NextRequest(redirect+"?state="+state+"&"+query,{headers:{host:"marktmorgen.com",cookie:`${SESSION_COOKIE}=${session}`}}));
  const installTrip=await startTrip({k:"install",sid:fundedDiscord.sid,by:"funded-discord@example.com",redirect});
  const beforeReturnRequests=discord.length;
  const returned=await callbackFor(installTrip,"code=synthetic_install_code");
  const returnDestination=new URL(returned.headers.get("location")??"https://none.invalid/");
  is("unapproved marked return stays at the studio before token exchange",[returned.status,returnDestination.hostname,returnDestination.searchParams.get("discord")],[303,"marktmorgen.com","limited"]);
  is("no provider call, server replacement or extra integration allowance",[discord.length,await readServer(storeKey(fundedDiscord)),await allowanceUsed(fundedDiscord,"integration")],[beforeReturnRequests,retainedServer,beforeInstallUnits]);
  const replay=await callbackFor(installTrip,"code=synthetic_install_code");
  is("the same trip remains single-use",new URL(replay.headers.get("location")!).searchParams.get("discord"),"expired");
  const declinedTrip=await startTrip({k:"install",sid:fundedDiscord.sid,by:"funded-discord@example.com",redirect});
  const declinedReturn=await callbackFor(declinedTrip,"error=access_denied");
  is("declining consent remains available without funding",new URL(declinedReturn.headers.get("location")!).searchParams.get("discord"),"declined");
  const invalidTrip=await startTrip({k:"install",sid:fundedDiscord.sid,by:"funded-discord@example.com",redirect});
  const invalidReturn=await callbackFor(invalidTrip,"code=%3Cinvalid%3E");
  is("invalid codes keep their existing refusal before financial admission",new URL(invalidReturn.headers.get("location")!).searchParams.get("discord"),"error");
  is("all refused and declined returns retain the original server and make no provider request",[await readServer(storeKey(fundedDiscord)),discord.length],[retainedServer,beforeReturnRequests]);

  part("Funded new role work refuses while role removal and disconnect remain available");
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: { ...paidPeriod(), funded: true } });
  const managementSession = await openSession(OWNER);
  const manage = (body: Record<string, unknown>) => manageDiscord(new NextRequest(`https://marktmorgen.com/api/store/discord?store=${store.sid}`, { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", cookie: `${SESSION_COOKIE}=${managementSession}` }, body: JSON.stringify(body) }));
  const beforeManagementRequests = discord.length;
  const newRole = await manage({ action: "role", name: "New members" });
  const newRoles = await manage({ action: "roles", productId, roles: [R1] });
  is("new provider role and nonempty assignment fail closed", [newRole.status, (await newRole.json()).error, newRoles.status, (await newRoles.json()).error], [503, "unavailable", 503, "unavailable"]);
  is("neither new operation asks Discord", discord.length, beforeManagementRequests);
  const removeRoles = await manage({ action: "roles", productId, roles: [] });
  is("removing product roles remains available without provider lookup", [removeRoles.status, (await removeRoles.json()).roles, discord.length], [200, [], beforeManagementRequests]);
  const disconnected = await manage({ action: "disconnect" });
  is("disconnect still reaches the existing provider cleanup", [disconnected.status, discord.includes(`DELETE /users/@me/guilds/${SERVER}`)], [200, true]);

  part("A trip to Discord's page");
  const state = await startTrip({ k: "join", sid: store.sid, email: "ana@example.com", redirect: "r", back: "/" });
  is("is read once", [(await takeTrip(state))?.k, await takeTrip(state)], ["join", null]);

  done();
}

/** The five minutes Stripe's answer is kept, gone: the next check asks again. */
async function redisFlushCache(): Promise<void> {
  const store = (await storeForEmail("owner@example.com"))!;
  await redis.pipeline([["DEL", `nl:dc:ok:${storeKey(store)}:${emailKey("ana@example.com")}:${productId}`]]);
}

main();
