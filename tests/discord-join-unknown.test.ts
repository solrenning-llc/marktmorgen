/**
 * "Join the Discord" (app/api/store/discord/join/route.ts) on reads that are not known (rule 24). The connected
 * server read in another shape (lost, text, a list, broken JSON) was read by readServer as "no server", so a buyer was
 * told the store has no Discord ("off"); and a Stripe read of the order that failed (readOrder's "error") was told
 * "No purchase with Discord access" ("none"). Both are unknown: the buyer now hears "failed" (nothing changed, try
 * again), never off or none, and no trip to Discord is started. Synthetic only: an in-memory Redis, a stand-in for
 * Stripe and Discord; nothing real is reached.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { seedDiscordServer as saveServer } from "./discord-server-fixture";
import { storeKey } from "@/lib/learn";
import { POST as join } from "@/app/api/store/discord/join/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { discordWords } from "@/lib/buyer-words/discord";
import { LANGUAGE_CODES } from "@/lib/store-language";

process.env.DISCORD_CLIENT_ID = "400000000000000001";
process.env.DISCORD_CLIENT_SECRET = "secret";
process.env.DISCORD_BOT_TOKEN = "bot";
process.env.STRIPE_SECRET_KEY = "sk_test_discord_join_unknown";

let stripeDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && stripeDown) return new Response(JSON.stringify({ error: { type: "api_error" } }), { status: 500 });
  return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing" } }), { status: 404 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
let bend: "real" | "lost" | "text" | "list" | "broken" = "real";
/** How the orders page's link (nl:orders:link:<token>) answers its GET. */
let linkBend: "real" | "lost" | "object" | "number" = "real";
const written: string[] = [];
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await real(commands);
  for (const command of commands) if (String(command[1] ?? "").startsWith("nl:dc:trip:")) written.push(String(command[0]));
  const isLinkRead = commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:orders:link:");
  if (isLinkRead && linkBend !== "real") return linkBend === "lost" ? [] : linkBend === "object" ? [{}] : [1];
  const isServerRead = commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:dc:srv:");
  if (bend === "real" || !isServerRead) return replies;
  if (bend === "lost") return [];
  if (bend === "text") return ["QUEUED"];
  if (bend === "list") return [[replies[0]]];
  return ["{not json"];
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  bend = "real";
  linkBend = "real";
  stripeDown = false;
  written.length = 0;
});

async function shop(): Promise<void> {
  const OWNER = "discord-join-unknown@example.com";
  await claimHandle(OWNER, "discordjoinunknown", "Discord Join", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestDiscJoin01", true);
  await setSubscription(OWNER, { customerId: "cus_DiscJoin01", subscriptionId: "sub_DiscJoin01", active: true, period: paidPeriod() });
  const product = await addProduct(OWNER, "The Club", "", "20", null);
  if (!product.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  await saveServer(storeKey(store), { id: "100000000000000001", name: "The Club", at: 1, kick: false });
}

async function press(form: Record<string, string>): Promise<string> {
  const body = new URLSearchParams({ handle: "discordjoinunknown", ...form });
  const response = await join(new NextRequest("https://marktmorgen.com/api/store/discord/join", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded" }, body }));
  return new URL(response.headers.get("location") ?? "https://x/").searchParams.get("status") ?? `HTTP ${response.status}`;
}

for (const shape of ["lost", "text", "list", "broken"] as const) {
  test(`a connected server read as ${shape} is "failed", never "off"`, async () => {
    await shop();
    bend = shape;
    assert.equal(await press({ session_id: "cs_test_" + "a".repeat(24) }), "failed");
    assert.deepEqual(written, []);
  });
}

test(`an order Stripe could not be asked about is "failed", never "none"`, async () => {
  await shop();
  stripeDown = true;
  assert.equal(await press({ session_id: "cs_test_" + "b".repeat(24) }), "failed");
  assert.deepEqual(written, []);
});

test(`no server kept is still "off", and an order Stripe says is not there is still "none"`, async () => {
  await shop();
  assert.equal(await press({ session_id: "cs_test_" + "c".repeat(24) }), "none");
  redis.clear();
  await shop();
  await redis.pipeline([["DEL", (await (async () => "nl:dc:srv:" + storeKey((await storeForEmail("discord-join-unknown@example.com"))!))())]]);
  assert.equal(await press({ session_id: "cs_test_" + "c".repeat(24) }), "off");
});

// The orders page's "Join the Discord" button names the buyer by the orders link (Claude 1, cloud reviewer C4, and
// H2 on #3780): a link that cannot be read is "failed" (try again), never "no purchase with Discord access".
for (const shape of ["lost", "object", "number"] as const) {
  test(`an orders link read as ${shape} is "failed", never "none"`, async () => {
    await shop();
    linkBend = shape;
    assert.equal(await press({ token: "a".repeat(64) }), "failed");
    assert.deepEqual(written, []);
  });
}

// An orders link that is not there any more (it works for 24 hours) is "link": the buyer is told to ask for a new one
// on the store's orders page, never "nothing bought with this address" (board #5285, row #2641: the MÉDIO on #2641).
test(`an orders link that is not there is "link", never "none"`, async () => {
  await shop();
  assert.equal(await press({ token: "a".repeat(64) }), "link");
  assert.deepEqual(written, []);
});

test(`every language says an expired orders link is expired, not that nothing was bought`, () => {
  for (const code of LANGUAGE_CODES) {
    const words = discordWords(code);
    const gone = (words.notices as Record<string, { title: string; body: string } | undefined>).link;
    assert.ok(gone?.title && gone.body, `${code}: a notice of its own`);
    assert.notEqual(gone.title, words.notices.none.title, `${code}: not the "no purchase" notice`);
    assert.match(gone.body, /24/, `${code}: says how long a link works`);
  }
});
