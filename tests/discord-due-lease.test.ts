/**
 * The Discord check's line (lib/discord-store.ts, dueMembers) when a run stops part-way (webhooks/cron audit,
 * Claude 1, 12/11/2026). The people due used to be taken off the line (ZREM) before any of them was checked, and
 * only a check that finished, or a catch that could still reach Redis, put them back. A run that died after the
 * ZREM (the function killed, or Redis failing for the put-back too, which throws out of sweepDiscord) dropped
 * everyone it had taken for good: nothing else puts a person back in line, so a buyer refunded or canceled later
 * kept the creator's paid roles forever. Now the people due are leased (moved a short while ahead, only if still
 * in line), so whoever a run did not finish comes due again on their own.
 * Synthetic only: an in-memory Redis, stand-ins for Stripe and Discord.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { CHECK_HOURS } from "@/lib/discord-rules";
import { joinServer, sweepDiscord } from "@/lib/discord-access";
import { DUE_LEASE_SECONDS, dueMembers, forgetMember, readMember, saveServer, setProductRoles } from "@/lib/discord-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SERVER = "100000000000000031";
const ROLE = "200000000000000031";
const ANA = "300000000000000031";
const BEA = "300000000000000032";
const OWNER = "owner-lease@example.com";
const ANA_MAIL = "ana-lease@example.com";
const BEA_MAIL = "bea-lease@example.com";

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
  const email = url.searchParams.get("customer_details[email]");
  if (path === "/checkout/sessions" && (email === ANA_MAIL || email === BEA_MAIL)) {
    return json({
      object: "list",
      data: [
        {
          id: `cs_test_lease_${email === ANA_MAIL ? "ana" : "bea"}`,
          status: "complete",
          payment_status: "paid",
          mode: "subscription",
          customer: "cus_Lease00001",
          metadata: { store: handle, product: productId },
          subscription: { id: "sub_Lease00001", status: stripe },
          payment_intent: null,
        },
      ],
      has_more: false,
    });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// Once `down` is set, every pipeline after the first one that takes people off or leases them fails, as Redis
// failing mid-run does: the store read of the first person and the put-back in the catch both throw.
const plain = redis.pipeline.bind(redis);
let down = false;
let linePassed = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (down && linePassed) throw new Error("redis is down (synthetic)");
  const answer = await plain(commands);
  if (down && commands.some((c) => (c[0] === "ZREM" || c[0] === "ZADD") && c[1] === "nl:dc:due")) linePassed = true;
  return answer;
}) as typeof redis.pipeline;

const score = async (member: string) => (await plain([["ZSCORE", "nl:dc:due", member]]))[0];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_discord_lease_stand_in";
  process.env.DISCORD_CLIENT_ID = "400000000000000031";
  process.env.DISCORD_CLIENT_SECRET = "secret";
  process.env.DISCORD_BOT_TOKEN = "bot";

  await claimHandle(OWNER, "leaseclub", "Lease Club", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLease01", true);
  await setSubscription(OWNER, { customerId: "cus_OwnerLse001", subscriptionId: "sub_OwnerLse001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "The Club", "", "20", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  handle = store.handle;
  const room = storeKey(store);
  await saveServer(room, { id: SERVER, name: "The Club", at: 1, kick: false });
  await setProductRoles(room, productId, [ROLE]);
  for (const [id, email] of [[ANA, ANA_MAIL], [BEA, BEA_MAIL]] as const) {
    const joined = await joinServer({ store, email, accessToken: "t", user: { id, name: id } });
    is(`set-up: ${email} is in the server with the product's role`, [joined.ok, (await readMember(room, id))?.r], [true, [ROLE]]);
  }
  const anaEntry = `${store.sid}|${ANA}`;
  const beaEntry = `${store.sid}|${BEA}`;
  let clock = Date.now() + CHECK_HOURS * 3_600_000 + 1_000;

  part("Redis failing mid-run: nobody the run took is dropped from the line");
  down = true;
  linePassed = false;
  let threw = false;
  try {
    await sweepDiscord(Date.now() + 30_000, clock);
  } catch {
    threw = true;
  }
  down = false;
  is("the run fails, as it does today", threw, true);
  is("the first person is still in line", (await score(anaEntry)) !== null, true);
  is("and so is the person the run never reached", (await score(beaEntry)) !== null, true);

  part("After the lease, both come due again, and a cancellation takes the paid roles back");
  stripe = "canceled";
  await plain([["DEL", `nl:dc:ok:${room}:${emailKey(ANA_MAIL)}:${productId}`], ["DEL", `nl:dc:ok:${room}:${emailKey(BEA_MAIL)}:${productId}`]]);
  is("not due again before the lease runs out", (await sweepDiscord(Date.now() + 30_000, clock + 1_000)).ended, 0);
  clock += DUE_LEASE_SECONDS * 1_000 + 2_000;
  discord.length = 0;
  const ended = await sweepDiscord(Date.now() + 30_000, clock);
  is("both are checked after the lease and their access ends", ended.ended, 2);
  is("each role given for the purchase is taken back in Discord", discord.sort(), [
    `DELETE /guilds/${SERVER}/members/${ANA}/roles/${ROLE}`,
    `DELETE /guilds/${SERVER}/members/${BEA}/roles/${ROLE}`,
  ].sort());
  is("and they are off the line", [await score(anaEntry), await score(beaEntry)], [null, null]);

  part("A lease never puts back somebody forgotten in between (an erasure)");
  stripe = "active";
  await plain([["DEL", `nl:dc:ok:${room}:${emailKey(ANA_MAIL)}:${productId}`]]);
  const back = await joinServer({ store, email: ANA_MAIL, accessToken: "t", user: { id: ANA, name: "Ana" } });
  is("set-up: back in the server", back.ok, true);
  await plain([["ZADD", "nl:dc:due", 0, anaEntry], ["ZADD", "nl:dc:due", 0, "sid-without-store|300000000000000033"]]);
  // Forgotten after the line was read: the lease must not add the entry back.
  const realPipeline = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "ZADD" && c[1] === "nl:dc:due" && c[2] === "XX")) {
      redis.pipeline = realPipeline;
      await forgetMember(room, store.sid, ANA, ANA_MAIL);
    }
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const line = await dueMembers(clock);
  redis.pipeline = realPipeline;
  is("the line read both", line.length, 2);
  is("the forgotten person is not added back by the lease", await score(anaEntry), null);

  part("A person whose store is gone leaves the line, never coming due again for ever");
  clock += DUE_LEASE_SECONDS * 1_000 + 2_000;
  const gone = await sweepDiscord(Date.now() + 30_000, clock);
  is("counted as gone", gone.gone, 1);
  is("and off the line", await score("sid-without-store|300000000000000033"), null);
  done();
}

main();
