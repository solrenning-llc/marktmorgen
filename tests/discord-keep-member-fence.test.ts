/**
 * A person is kept in a Discord server's list only while that server is still connected (Board #5010, row 187; Claude 3
 * yUZf's LEVE on #5380). A join reads the connected server at its start, then waits on Discord (putMember, giveRole),
 * and only then keeps the person (keepMember: their row, their address link, their due entry). The periodic check does
 * the same around its own Discord calls. When the creator's Disconnect ran whole inside that wait, the late keepMember
 * wrote the row and the buyer's address link into a room with no server: a later Disconnect answers "not connected",
 * the check drops the due entry only, and nothing forgets the link.
 *
 * Now keepMember writes only while the server's key is there, in one step with the write (ORDER_WRITE_IF_KEY), and
 * answers false otherwise, with nothing written; the join then answers "off", and the check takes the person off the
 * line ("gone"). Synthetic only: Redis is the in-memory stand-in; Stripe and Discord are stand-in fetches (no network).
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { forgetServer, keepMember, setProductRoles } from "@/lib/discord-store";
import { checkMember, joinServer } from "@/lib/discord-access";
import { CHECK_HOURS } from "@/lib/discord-rules";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seedDiscordServer } from "./discord-server-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let handle = "";
let productId = "";
/** Runs once, inside the next Discord member add or role give: the creator's whole Disconnect in that wait. */
let midWait: (() => Promise<unknown>) | null = null;
const inTheWait = async () => {
  const run = midWait;
  midWait = null;
  if (run) await run();
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "discord.com") {
    const path = url.pathname.replace("/api/v10", "");
    if (/^\/guilds\/\d+\/members\/\d+$/.test(path) && method === "PUT") {
      await inTheWait();
      return new Response("{}", { status: 201 });
    }
    if (/^\/guilds\/\d+\/members\/\d+\/roles\/\d+$/.test(path)) {
      if (method === "PUT") await inTheWait();
      return new Response(null, { status: 204 });
    }
    return json({ message: "no stand-in" }, 404);
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && url.searchParams.get("customer_details[email]") === BEN) {
    return json({
      object: "list",
      data: [
        {
          id: "cs_test_keep_fence_ben",
          status: "complete",
          payment_status: "paid",
          mode: "subscription",
          customer: "cus_KeepFence01",
          metadata: { store: handle, product: productId },
          subscription: { id: "sub_KeepFence01", status: "active" },
          payment_intent: null,
        },
      ],
      has_more: false,
    });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "owner@discord-keep-fence.example";
const BEN = "ben@discord-keep-fence.example";
const BEN_ID = "123456789012345691";
const SERVER = "223456789012345698";
const ROLE = "323456789012345698";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "discord-keep-fence", "Discord Keep Fence", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  const sid = store.sid;
  const keys = { server: `nl:dc:srv:${room}`, members: `nl:dc:mem:${room}`, ben: `nl:dc:addr:${room}:${emailKey(BEN)}` };
  const member = { e: BEN, n: "buyer", p: ["p1"], r: [ROLE], at: 1, checked: 1 };
  const ben = async () => {
    const [link, row, due] = await redis.pipeline([["GET", keys.ben], ["HGET", keys.members, BEN_ID], ["ZSCORE", "nl:dc:due", `${sid}|${BEN_ID}`]]);
    return { link, row: row !== null, due: due !== null };
  };

  part("Control: with the server connected, the person is kept");
  await redis.pipeline([["SET", keys.server, JSON.stringify({ id: SERVER, name: "Server", at: 1, kick: false })]]);
  is("kept", await keepMember(room, sid, BEN_ID, member), true);
  is("row, link and due entry written", await ben(), { link: BEN_ID, row: true, due: true });

  part("A Disconnect that ran whole before the late write: nothing is written");
  is("the Disconnect forgets Ben", await forgetServer(room, sid), 1);
  is("nothing is left", [await ben(), (await redis.pipeline([["EXISTS", keys.server]]))[0]], [{ link: null, row: false, due: false }, 0]);
  // The join that read the server before the Disconnect, and waited on Discord through it, keeps Ben now.
  is("the late keep is refused", await keepMember(room, sid, BEN_ID, member), false);
  is("no row, no address link, no due entry with nobody to forget them", await ben(), { link: null, row: false, due: false });

  // Claude 3 yUZf's LEVE on #5419 (7108818559): a keep landing between the Disconnect's people's step (FORGET_PEOPLE)
  // and its server's step found the server key still there. The server's step now deletes only while nobody is on the
  // list (DROP_SERVER_IF_EMPTY, #5380), so that keep stays with its server, the Disconnect says not finished, and the
  // next press forgets it with its address link and due entry.
  part("A keep between the Disconnect's people's step and its server's step: kept with the server, forgotten next press");
  const plain = redis.pipeline.bind(redis);
  for (const people of [true, false]) {
    await redis.pipeline([["SET", keys.server, JSON.stringify({ id: SERVER, name: "Server", at: 1, kick: false })]]);
    const ANA_ID = "123456789012345692";
    if (people) await keepMember(room, sid, ANA_ID, { ...member, e: "ana@discord-keep-fence.example" });
    let landed: boolean | null = null;
    // Right before the server's step (the first pipeline after the people's step, or the first one with nobody kept),
    // Ben's join lands.
    let peopleDone = !people;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const first = commands[0];
      // The server's step: DROP_SERVER_IF_EMPTY now; before #5380, the plain DEL of the server's keys.
      const isServerStep = (first?.[0] === "EVAL" && String(first[1]).startsWith("-- marktmorgen:discord-drop-server-if-empty:v1")) || (first?.[0] === "DEL" && String(first[1]).startsWith("nl:dc:srv:"));
      if (peopleDone && landed === null && isServerStep) {
        redis.pipeline = plain;
        landed = await keepMember(room, sid, BEN_ID, member);
      }
      const answer = await plain(commands);
      if (first?.[0] === "EVAL" && String(first[1]).startsWith("-- marktmorgen:discord-forget-people:v1")) peopleDone = true;
      return answer;
    }) as typeof redis.pipeline;
    let said: string | number;
    try {
      said = await forgetServer(room, sid);
    } catch (error) {
      said = `rejected: ${error instanceof Error ? error.message : "?"}`;
    }
    redis.pipeline = plain;
    const label = people ? "with a person kept before" : "with nobody kept before";
    is(`${label}: the late keep lands, and the Disconnect says it did not forget everyone`, [landed, typeof said === "string" && said.startsWith("rejected")], [true, true]);
    is(`${label}: Ben stays with his server, link and due entry, so nothing is left without a server`, [await ben(), (await redis.pipeline([["EXISTS", keys.server]]))[0]], [{ link: BEN_ID, row: true, due: true }, 1]);
    is(`${label}: the next press forgets Ben with his link and due entry, and the server`, [await forgetServer(room, sid), await ben(), (await redis.pipeline([["EXISTS", keys.server]]))[0]], [1, { link: null, row: false, due: false }, 0]);
  }

  part("A join whose server is disconnected while it waits on Discord answers off and keeps nothing");
  process.env.STRIPE_SECRET_KEY = "sk_test_discord_keep_fence_stand_in";
  process.env.DISCORD_CLIENT_ID = "400000000000000091";
  process.env.DISCORD_CLIENT_SECRET = "secret";
  process.env.DISCORD_BOT_TOKEN = "bot";
  await setStripeAccount(OWNER, "acct_1TestKeepFnc1", true);
  await setSubscription(OWNER, { customerId: "cus_OwnerKpf001", subscriptionId: "sub_OwnerKpf001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "The Fence Club", "", "20", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  const live = (await storeForEmail(OWNER))!;
  handle = live.handle;
  const connect = async () => {
    await seedDiscordServer(room, { id: SERVER, name: "Server", at: 1, kick: false });
    await setProductRoles(room, productId, [ROLE]);
  };
  await connect();
  midWait = () => forgetServer(room, sid);
  const joined = await joinServer({ store: live, email: BEN, accessToken: "t", user: { id: BEN_ID, name: "ben" } });
  is("the join answers off", joined, { ok: false, reason: "off" });
  is("no row, no address link, no due entry", await ben(), { link: null, row: false, due: false });
  await connect();
  const control = await joinServer({ store: live, email: BEN, accessToken: "t", user: { id: BEN_ID, name: "ben" } });
  is("control: the same join with the server connected is kept", [control.ok, await ben()], [true, { link: BEN_ID, row: true, due: true }]);

  part("A check whose server is disconnected while it gives a role takes the person off the line and keeps nothing");
  const later = Date.now() + CHECK_HOURS * 3_600_000 + 1_000;
  // Ben's record without the role, so the check gives it back on Discord, and the Disconnect runs in that wait.
  const roleless = async () => redis.pipeline([["HSET", keys.members, BEN_ID, JSON.stringify({ ...member, r: [] })]]);
  await roleless();
  midWait = () => forgetServer(room, sid);
  is("the check answers gone", await checkMember(sid, BEN_ID, later), "gone");
  is("no row, no address link, no due entry", await ben(), { link: null, row: false, due: false });
  await connect();
  await joinServer({ store: live, email: BEN, accessToken: "t", user: { id: BEN_ID, name: "ben" } });
  await roleless();
  is("control: the same check with the server connected gives the role and keeps Ben", [await checkMember(sid, BEN_ID, later), await ben()], ["changed", { link: BEN_ID, row: true, due: true }]);

  part("The check's other keeps go through the same fence");
  const access = readFileSync(join(process.cwd(), "lib/discord-access.ts"), "utf8");
  is("every keepMember in a check is read by stay()", (access.match(/return stay\(await keepMember\(/g) ?? []).length, 4);

  done();
}

main();
