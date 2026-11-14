/**
 * Discord's error code is read in its exact shape (CX-123 rule 24; lib/discord.ts, `changed`).
 *
 * A 404 says "the person left" or "the role is gone" only with Discord's own whole-number code (10007, 10011,
 * 10004). A code of another shape (the string "10007", the list [10007], " 10007 ") is not known: the change is
 * "failed", never "gone". Before, `Number(code)` turned those shapes into the numbers, and the check of a person
 * whose access ended took them as already out of the server: the removal the creator asked for was skipped and
 * the person was forgotten while the bot never took their role back.
 *
 * leaveServer reads the same code the same way: a 404 says the bot is already out of the server only with Discord's
 * whole number 10004; "10004" or [10004] is not known, so the disconnect is not said done while the bot may be in.
 *
 * Synthetic store, synthetic Stripe and Discord stand-ins; nothing real is called.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { giveRole, leaveServer, removeMember, takeRole } from "@/lib/discord";
import { checkMember, joinServer } from "@/lib/discord-access";
import { readMember, saveServer, setProductRoles } from "@/lib/discord-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SERVER = "100000000000000011";
const R1 = "200000000000000011";
const ANA = "300000000000000011";
const OWNER = "owner-exact@example.com";
const BUYER = "ana-exact@example.com";

let stripe: "active" | "canceled" = "active";
let handle = "";
let productId = "";
const calls: string[] = [];
const members = new Set<string>();
/** What Discord answers to a role change or a removal; null is the healthy 204. */
let reply: { status: number; body: unknown } | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "discord.com") {
    const path = url.pathname.replace("/api/v10", "");
    calls.push(`${method} ${path}`);
    const member = path.match(/^\/guilds\/\d+\/members\/(\d+)$/);
    if (member && method === "PUT") {
      const fresh = !members.has(member[1]);
      members.add(member[1]);
      return new Response(fresh ? "{}" : null, { status: fresh ? 201 : 204 });
    }
    if (member && method === "DELETE") {
      if (reply) return json(reply.body, reply.status);
      members.delete(member[1]);
      return new Response(null, { status: 204 });
    }
    if (/^\/guilds\/\d+\/members\/\d+\/roles\/\d+$/.test(path)) return reply ? json(reply.body, reply.status) : new Response(null, { status: 204 });
    if (/^\/users\/@me\/guilds\/\d+$/.test(path) && method === "DELETE") return reply ? json(reply.body, reply.status) : new Response(null, { status: 204 });
    return json({ message: "no stand-in" }, 404);
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && url.searchParams.get("customer_details[email]") === BUYER) {
    return json({
      object: "list",
      data: [
        {
          id: "cs_test_exact",
          status: "complete",
          payment_status: "paid",
          mode: "subscription",
          customer: "cus_Exact000001",
          metadata: { store: handle, product: productId },
          subscription: { id: "sub_Exact000001", status: stripe },
          payment_intent: null,
        },
      ],
      has_more: false,
    });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The 404 bodies whose code is not Discord's whole number: each is unknown, never "gone". */
const ODD_CODES: [string, unknown][] = [
  ["the string \"10007\"", "10007"],
  ["the list [10007]", [10007]],
  ["the padded string \" 10011 \"", " 10011 "],
  ["the string \"10004\"", "10004"],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_discord_exact_stand_in";
  process.env.DISCORD_CLIENT_ID = "400000000000000011";
  process.env.DISCORD_CLIENT_SECRET = "secret";
  process.env.DISCORD_BOT_TOKEN = "bot";

  part("A role change or a removal, by the shape of Discord's answer");
  for (const [what, code] of ODD_CODES) {
    reply = { status: 404, body: { message: "Unknown Member", code } };
    is(`404 with ${what}: giving a role failed, not gone`, await giveRole(SERVER, ANA, R1, "t"), "failed");
    is(`404 with ${what}: taking a role failed, not gone`, await takeRole(SERVER, ANA, R1, "t"), "failed");
    is(`404 with ${what}: the removal failed, not gone`, await removeMember(SERVER, ANA, "t"), "failed");
  }
  // Controls: Discord's own shapes keep their meaning.
  reply = { status: 404, body: { message: "Unknown Member", code: 10007 } };
  is("control: 404 with the number 10007 is gone", await takeRole(SERVER, ANA, R1, "t"), "gone");
  reply = { status: 404, body: { message: "Unknown Role", code: 10011 } };
  is("control: 404 with the number 10011 is gone", await giveRole(SERVER, ANA, R1, "t"), "gone");
  reply = { status: 404, body: { message: "Unknown Guild", code: 10004 } };
  is("control: 404 with the number 10004 is gone", await removeMember(SERVER, ANA, "t"), "gone");
  reply = { status: 404, body: { message: "Unknown Channel", code: 10003 } };
  is("control: 404 with another number fails", await takeRole(SERVER, ANA, R1, "t"), "failed");
  reply = { status: 404, body: null };
  is("control: 404 with no code fails", await takeRole(SERVER, ANA, R1, "t"), "failed");
  reply = { status: 403, body: { message: "Missing Permissions", code: 50013 } };
  is("control: 403 fails", await takeRole(SERVER, ANA, R1, "t"), "failed");
  reply = null;
  is("control: 204 is ok", await takeRole(SERVER, ANA, R1, "t"), "ok");

  part("The bot leaving a server, by the shape of Discord's answer (rule 30: the same read in leaveServer)");
  for (const [what, code] of [["the string \"10004\"", "10004"], ["the list [10004]", [10004]], ["the padded string \" 10004 \"", " 10004 "]] as [string, unknown][]) {
    reply = { status: 404, body: { message: "Unknown Guild", code } };
    is(`404 with ${what}: the bot is not known to be out`, await leaveServer(SERVER), false);
  }
  reply = { status: 404, body: { message: "Unknown Guild", code: 10004 } };
  is("control: 404 with the number 10004 means the bot is out", await leaveServer(SERVER), true);
  reply = { status: 404, body: { message: "Unknown Member", code: 10007 } };
  is("control: 404 with another number is not out", await leaveServer(SERVER), false);
  reply = null;
  is("control: 204 means the bot left", await leaveServer(SERVER), true);

  part("The check of a person whose access ended, on an answer of another shape");
  await claimHandle(OWNER, "exactclub", "Exact Club", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestExactClub1", true);
  await setSubscription(OWNER, { customerId: "cus_ExactOwner01", subscriptionId: "sub_ExactOwner01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "The Exact Club", "", "20", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  handle = store.handle;
  const room = storeKey(store);
  const flush = () => redis.pipeline([["DEL", `nl:dc:ok:${room}:${emailKey(BUYER)}:${productId}`]]);
  await saveServer(room, { id: SERVER, name: "The Exact Club", at: 1, kick: true });
  await setProductRoles(room, productId, [R1]);

  for (const [what, code] of ODD_CODES) {
    stripe = "active";
    reply = null;
    await flush();
    const joined = await joinServer({ store, email: BUYER, accessToken: "t", user: { id: ANA, name: "Ana" } });
    is(`(${what}) set-up: the buyer is in, with the role`, [joined.ok, members.has(ANA), (await readMember(room, ANA))?.r], [true, true, [R1]]);
    stripe = "canceled";
    await flush();
    reply = { status: 404, body: { message: "Unknown Member", code } };
    calls.length = 0;
    const checked = await checkMember(store.sid, ANA);
    const kept = await readMember(room, ANA);
    is(`404 with ${what} on taking the role back: tried again later, never ended`, checked, "later");
    is(`404 with ${what}: the person is kept with the role still to take back`, kept?.r, [R1]);
    is(`404 with ${what}: still in the server, so never forgotten as "already out"`, [members.has(ANA), kept !== null], [true, true]);
  }

  part("Control: the healthy check still ends access and removes the person");
  reply = null;
  stripe = "active";
  await flush();
  await joinServer({ store, email: BUYER, accessToken: "t", user: { id: ANA, name: "Ana" } });
  stripe = "canceled";
  await flush();
  calls.length = 0;
  is("the role is taken back, the person removed and forgotten", [await checkMember(store.sid, ANA), calls.sort(), members.has(ANA), await readMember(room, ANA)], ["ended", [`DELETE /guilds/${SERVER}/members/${ANA}`, `DELETE /guilds/${SERVER}/members/${ANA}/roles/${R1}`], false, null]);

  part("Control: Discord's own 10007 still means the person left");
  stripe = "active";
  await flush();
  await joinServer({ store, email: BUYER, accessToken: "t", user: { id: ANA, name: "Ana" } });
  stripe = "canceled";
  await flush();
  reply = { status: 404, body: { message: "Unknown Member", code: 10007 } };
  is("already out of the server: ended and forgotten", [await checkMember(store.sid, ANA), await readMember(room, ANA)], ["ended", null]);
  reply = null;

  done();
}

main();
