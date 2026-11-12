/**
 * The Discord check (lib/discord-access.ts, checkMember) when the store itself
 * cannot be read (CX-123 rule 24). The person due is taken off the line before
 * they are checked (lib/discord-store.ts, dueMembers), so a check that answers
 * "gone" on an error drops them for good: a buyer whose membership is then
 * canceled or refunded in Stripe keeps the paid roles forever, because nobody
 * checks them again. A store read that fails is unknown, never "the store is
 * gone": the sweep keeps the person in line and the next run checks them.
 * Synthetic only: an in-memory Redis, stand-ins for Stripe and Discord.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { CHECK_HOURS } from "@/lib/discord-rules";
import { joinServer, sweepDiscord } from "@/lib/discord-access";
import { dueMembers, readMember, saveServer, setProductRoles } from "@/lib/discord-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SERVER = "100000000000000011";
const ROLE = "200000000000000011";
const ANA = "300000000000000011";
const OWNER = "owner-unknown@example.com";
const BUYER = "ana-unknown@example.com";

let stripe: "active" | "canceled" = "active";
let handle = "";
let productId = "";
const discord: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "discord.com") {
    const path = url.pathname.replace("/api/v10", "");
    discord.push(`${method} ${path}`);
    if (/^\/guilds\/\d+\/members\/\d+$/.test(path) && method === "PUT") return new Response("{}", { status: 201 });
    if (/^\/guilds\/\d+\/members\/\d+\/roles\/\d+$/.test(path)) return new Response(null, { status: 204 });
    return json({ message: "no stand-in" }, 404);
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && url.searchParams.get("customer_details[email]") === BUYER) {
    return json({
      object: "list",
      data: [
        {
          id: "cs_test_unknown_ana",
          status: "complete",
          payment_status: "paid",
          mode: "subscription",
          customer: "cus_Unknown0001",
          metadata: { store: handle, product: productId },
          subscription: { id: "sub_Unknown0001", status: stripe },
          payment_intent: null,
        },
      ],
      has_more: false,
    });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// The store's own record read failing once, as a Redis timeout or a 503 does (lib/redis.ts throws then).
const plain = redis.pipeline;
let storeReadFails = 0;
redis.pipeline = async (commands: (string | number)[][]) => {
  if (storeReadFails > 0 && commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:store:id:"))) {
    storeReadFails -= 1;
    throw new Error("Redis request failed with status 503");
  }
  return plain(commands);
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_discord_unknown_stand_in";
  process.env.DISCORD_CLIENT_ID = "400000000000000011";
  process.env.DISCORD_CLIENT_SECRET = "secret";
  process.env.DISCORD_BOT_TOKEN = "bot";

  await claimHandle(OWNER, "unknownclub", "Unknown Club", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestUnknown1", true);
  await setSubscription(OWNER, { customerId: "cus_OwnerUnk001", subscriptionId: "sub_OwnerUnk001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "The Club", "", "20", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  handle = store.handle;
  const room = storeKey(store);
  const forgetCache = () => redis.pipeline([["DEL", `nl:dc:ok:${room}:${emailKey(BUYER)}:${productId}`]]);
  await saveServer(room, { id: SERVER, name: "The Club", at: 1, kick: false });
  await setProductRoles(room, productId, [ROLE]);
  const joined = await joinServer({ store, email: BUYER, accessToken: "t", user: { id: ANA, name: "Ana" } });
  is("set-up: the buyer is in the server with the product's role", [joined.ok, (await readMember(room, ANA))?.r], [true, [ROLE]]);

  part("A store read that fails is unknown, never \"gone\"");
  const later = Date.now() + CHECK_HOURS * 3_600_000 + 1_000;
  storeReadFails = 1;
  const first = await sweepDiscord(Date.now() + 30_000, later);
  is("the check is put off, not counted as a store that is gone", [first.gone, first.later], [0, 1]);
  is("the person is kept, roles and all", (await readMember(room, ANA))?.r, [ROLE]);
  const line = await dueMembers(later + 1_000);
  is("and is back in line for the next run", line.some((d) => d.userId === ANA), true);

  part("Canceled later: the next run takes the paid role back");
  stripe = "canceled";
  await forgetCache();
  discord.length = 0;
  // Put back exactly what dueMembers took off above, so the next sweep finds them if they were in line.
  if (line.some((d) => d.userId === ANA)) await redis.pipeline([["ZADD", "nl:dc:due", 0, `${store.sid}|${ANA}`]]);
  const second = await sweepDiscord(Date.now() + 30_000, later + 2_000);
  is("the run reaches the person and ends their access", second.ended, 1);
  is("the role given for the purchase is taken back in Discord", discord, [`DELETE /guilds/${SERVER}/members/${ANA}/roles/${ROLE}`]);
  done();
}

main();
