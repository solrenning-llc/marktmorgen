/**
 * The Discord check (lib/discord-access.ts, checkMember) when the store's own id key answers in a shape that is not a
 * store reference (CX-123 rule 24). The person due is taken off the line before they are checked
 * (lib/discord-store.ts, dueMembers), so a check that reads such a reply as "the store is gone" drops them for good:
 * a buyer whose membership is then canceled or refunded keeps the creator's paid roles forever. Only a confirmed
 * absent key (an exact null) is "gone"; any other shape, or a key leading to a record that cannot be read, is unknown:
 * the sweep keeps the person, roles and all, back in line for the next run.
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

const SERVER = "100000000000000012";
const ROLE = "200000000000000012";
const ANA = "300000000000000012";
const OWNER = "owner-shape@example.com";
const BUYER = "ana-shape@example.com";

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
          id: "cs_test_shape_ana",
          status: "complete",
          payment_status: "paid",
          mode: "subscription",
          customer: "cus_Shape0001",
          metadata: { store: handle, product: productId },
          subscription: { id: "sub_Shape0001", status: stripe },
          payment_intent: null,
        },
      ],
      has_more: false,
    });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// The pipeline that reads the store's id key answers `idReply(...)` instead, once, when set.
const plain = redis.pipeline.bind(redis);
let idReply: ((commands: (string | number)[][]) => unknown[]) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (idReply && commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:store:id:"))) {
    const answer = idReply(commands);
    idReply = null;
    return answer;
  }
  return plain(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_discord_shape_stand_in";
  process.env.DISCORD_CLIENT_ID = "400000000000000012";
  process.env.DISCORD_CLIENT_SECRET = "secret";
  process.env.DISCORD_BOT_TOKEN = "bot";

  await claimHandle(OWNER, "shapeclub", "Shape Club", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestShape01", true);
  await setSubscription(OWNER, { customerId: "cus_OwnerShp001", subscriptionId: "sub_OwnerShp001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "The Club", "", "20", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  handle = store.handle;
  const room = storeKey(store);
  const entry = `${store.sid}|${ANA}`;
  const forgetCache = () => redis.pipeline([["DEL", `nl:dc:ok:${room}:${emailKey(BUYER)}:${productId}`]]);
  await saveServer(room, { id: SERVER, name: "The Club", at: 1, kick: false });
  await setProductRoles(room, productId, [ROLE]);
  const joined = await joinServer({ store, email: BUYER, accessToken: "t", user: { id: ANA, name: "Ana" } });
  is("set-up: the buyer is in the server with the product's role", [joined.ok, (await readMember(room, ANA))?.r], [true, [ROLE]]);

  let clock = Date.now() + CHECK_HOURS * 3_600_000 + 1_000;
  const putInLine = () => redis.pipeline([["ZADD", "nl:dc:due", 0, entry]]);
  const inLine = async () => {
    const line = await dueMembers(clock + 1_000);
    // dueMembers takes them off: put back exactly what it took.
    if (line.some((d) => d.userId === ANA)) await putInLine();
    return line.some((d) => d.userId === ANA);
  };

  const shapes: [string, (commands: (string | number)[][]) => unknown[]][] = [
    ["an array", (commands) => commands.map(() => [1])],
    ["a number", (commands) => commands.map(() => 7)],
    ["an empty string", (commands) => commands.map(() => "")],
    ["no reply at all", () => []],
  ];
  for (const [name, reply] of shapes) {
    part(`The store's id key answering ${name} is unknown, never "gone"`);
    clock += 10_000;
    await putInLine();
    discord.length = 0;
    idReply = reply;
    const got = await sweepDiscord(Date.now() + 30_000, clock);
    is(`${name}: the check is put off, not counted as a store that is gone`, [got.gone, got.later], [0, 1]);
    is(`${name}: the person is kept, roles and all`, (await readMember(room, ANA))?.r, [ROLE]);
    is(`${name}: nothing is asked of Discord`, discord, []);
    is(`${name}: and is back in line for the next run`, await inLine(), true);
  }

  part("The id key leading to a record that cannot be read is unknown, never \"gone\"");
  clock += 10_000;
  await putInLine();
  idReply = () => ["missing-record@example.com"];
  const orphan = await sweepDiscord(Date.now() + 30_000, clock);
  is("unreadable record: put off, not gone", [orphan.gone, orphan.later], [0, 1]);
  is("unreadable record: the person is kept, back in line", [(await readMember(room, ANA))?.r, await inLine()], [[ROLE], true]);

  part("Healthy control: the store reads, the person is kept as before");
  clock += 10_000;
  await putInLine();
  const healthy = await sweepDiscord(Date.now() + 30_000, clock);
  is("healthy: kept, nothing put off", [healthy.kept, healthy.later, healthy.gone], [1, 0, 0]);

  part("Canceled: the next run after an unknown reply takes the paid role back");
  stripe = "canceled";
  await forgetCache();
  clock += CHECK_HOURS * 3_600_000 + 10_000;
  await putInLine();
  idReply = (commands) => commands.map(() => [1]);
  const putOff = await sweepDiscord(Date.now() + 30_000, clock);
  is("the unknown run puts the check off", [putOff.gone, putOff.later], [0, 1]);
  discord.length = 0;
  clock += 10_000;
  const ended = await sweepDiscord(Date.now() + 30_000, clock);
  is("the run after reaches the person and ends their access", ended.ended, 1);
  is("the role given for the purchase is taken back in Discord", discord, [`DELETE /guilds/${SERVER}/members/${ANA}/roles/${ROLE}`]);

  part("Confirmed absent: an exact null is \"gone\", as before");
  stripe = "active";
  await forgetCache();
  const rejoined = await joinServer({ store, email: BUYER, accessToken: "t", user: { id: ANA, name: "Ana" } });
  is("set-up: back in the server", rejoined.ok, true);
  clock += 10_000;
  await putInLine();
  idReply = (commands) => commands.map(() => null);
  const gone = await sweepDiscord(Date.now() + 30_000, clock);
  is("exact null: counted as gone", [gone.gone, gone.later], [1, 0]);
  is("exact null: not put back in line", await inLine(), false);
  done();
}

main();
