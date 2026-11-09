/**
 * The API door's limits, in the order they are checked (lib/api-guard.ts):
 *
 * - A paused key (its maker left the team, a role changed, the two-step rule)
 *   is counted in the same per-key minute as a live key before it is told it
 *   is paused, so past API_RATE it hears 429 like any key.
 * - A key that may not do what the route does (a read-only key on a write, a
 *   key with no agent scope on a preparation) is refused before any of the
 *   store's month is taken.
 * - Switching a discount code off (DELETE /api/v1/codes), which reads the
 *   store's codes on Stripe and sends them back, waits while the plan's
 *   renewal is unpaid or disputed, as making one does, before any of the month
 *   is taken, and the sentence it answers with says so.
 * - A key past its minute, paused or live, costs only the lookup of its hash
 *   and the minute's counter (KEY_PAST_MINUTE_COMMANDS) before it hears 429:
 *   the key's record, hold, last use and the team are not read. A counter
 *   that cannot be read refuses the key the same way, with 503, never 429.
 *
 * Synthetic store and keys, Redis in memory; no outside request.
 */
import { GET as products } from "@/app/api/v1/products/route";
import { POST as leadAdd } from "@/app/api/v1/leads/route";
import { DELETE as codeStop } from "@/app/api/v1/codes/route";
import { readFileSync } from "node:fs";
import { POST as mcp } from "@/app/api/mcp/route";
import { API_RATE, KEY_PAUSED_WORDS } from "@/lib/api-guard";
import { makeKey } from "@/lib/api-keys";
import { allowanceUsed } from "@/lib/store-allowance";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { API_WRITE_PAUSED_WORDS } from "@/lib/integration-pause";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/**
 * What a key past its minute may cost before it hears 429, measured: the GET
 * of its hash's lookup and the minute's SET NX + INCR. Before the counter
 * moved into resolveKey it was 7 for a paused key (the four reads of its
 * record, hold, last use and team came first). tests/plan-cost-registry.ts
 * (rest-api) carries the same figure for the refused traffic.
 */
const KEY_PAST_MINUTE_COMMANDS = 3;

type Body = { error?: string; message?: string; result?: unknown };

async function storeOf(owner: string, handle: string, ids: string) {
  await claimHandle(owner, handle, "Synthetic door limits", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${ids}`, subscriptionId: `sub_${ids}`, active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  if (!store.subscriptionActive) throw new Error("No synthetic paid store");
  return store;
}

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => { outside += 1; throw new Error("No outside requests in this test"); }) as typeof fetch;
  try {
    const ask = async (handler: (r: Request) => Promise<Response>, key: string, path: string, method = "GET", body?: unknown) => {
      const res = await handler(new Request(`https://marktmorgen.com${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      return { status: res.status, body: (await res.json()) as Body };
    };

    part("A paused key is counted in the per-key minute before it hears it is paused");
    const first = await storeOf("guard-limits-paused@example.com", "guard-limits-paused", "GuardLimitsPaused");
    const left = await makeKey(first.sid, "Left sync", Date.now(), false, "none", { owner: false, by: "", step: false, left: true });
    if (!left.ok) throw new Error("No synthetic key");
    const answers: { status: number; body: Body }[] = [];
    for (let i = 0; i < API_RATE + 5; i += 1) answers.push(await ask(products, left.key, "/api/v1/products"));
    const within = answers.slice(0, API_RATE);
    is("inside the minute it is told it is paused, and why", within.every((a) => a.status === 403 && a.body.error === "key_paused" && a.body.message === KEY_PAUSED_WORDS.left), true);
    const past = answers.slice(API_RATE);
    is("past API_RATE in the minute it hears 429 like any key", past.map((a) => [a.status, a.body.error]), past.map(() => [429, "rate_limited"]));
    is("none of the store's month is taken by a paused key", await allowanceUsed((await storeForEmail("guard-limits-paused@example.com"))!, "api"), 0);

    part("A key that may not do what the route does is refused before the month is taken");
    const second = await storeOf("guard-limits-scope@example.com", "guard-limits-scope", "GuardLimitsScope");
    const product = await addProduct("guard-limits-scope@example.com", "Guide", "A guide.", "29", null);
    if (!product.ok) throw new Error("no product");
    const reader = await makeKey(second.sid, "Reader", Date.now(), false);
    if (!reader.ok) throw new Error("No synthetic key");
    const used = async () => allowanceUsed((await storeForEmail("guard-limits-scope@example.com"))!, "api");
    const write = await ask(leadAdd, reader.key, "/api/v1/leads", "POST", { email: "someone@example.com", agreed: true });
    is("a read-only key on a write hears it reads only", [write.status, write.body.error], [403, "read_only"]);
    is("and takes none of the store's month", await used(), 0);
    const stop = await ask(codeStop, reader.key, "/api/v1/codes?id=promo_Synthetic1", "DELETE");
    is("a read-only key switching a code off hears it reads only", [stop.status, stop.body.error], [403, "read_only"]);
    is("and takes none of the store's month either", await used(), 0);
    const res = await mcp(new Request("https://marktmorgen.com/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${reader.key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "propose_product_description", arguments: { product: product.product.id, description: "New words." } } }),
    }));
    const proposed = (await res.json()) as { error?: { code: number; message: string } };
    is("a key with no agent scope cannot prepare a change", [proposed.error?.code, proposed.error?.message], [-32001, "This key cannot prepare changes for you to confirm."]);
    is("and takes none of the store's month", await used(), 0);
    const control = await ask(products, reader.key, "/api/v1/products");
    is("control: the same key reads, and that is counted", [control.status, (await used()) > 0], [200, true]);

    part("Switching a code off waits while the renewal is unpaid, before the month is taken");
    const third = await storeOf("guard-limits-codes@example.com", "guard-limits-codes", "GuardLimitsCodes");
    const writer = await makeKey(third.sid, "Writer", Date.now(), true);
    if (!writer.ok) throw new Error("No synthetic key");
    const usedCodes = async () => allowanceUsed((await storeForEmail("guard-limits-codes@example.com"))!, "api");
    const paidStop = await ask(codeStop, writer.key, "/api/v1/codes?id=promo_Synthetic1", "DELETE");
    is("control: paid, the route answers for itself (not selling while plans are off sale)", [paidStop.status, paidStop.body.error], [409, "not_selling"]);
    const before = await usedCodes();
    await setSubscription("guard-limits-codes@example.com", { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
    const pausedStop = await ask(codeStop, writer.key, "/api/v1/codes?id=promo_Synthetic1", "DELETE");
    is("unpaid: refused with the pause's sentence", [pausedStop.status, pausedStop.body.error, pausedStop.body.message], [409, "paused_unpaid", API_WRITE_PAUSED_WORDS.paused_unpaid]);
    is("and nothing of the month is taken", await usedCodes(), before);
    part("Making or switching off a discount code is named in the pause's sentence");
    is("both sentences name discount codes", Object.values(API_WRITE_PAUSED_WORDS).map((w) => /making or switching off discount codes/.test(w)), [true, true]);
    is("both sentences name an AI assistant's prepared change, which waits the same way (apiAgent)", Object.values(API_WRITE_PAUSED_WORDS).map((w) => /having an AI assistant prepare a change for you to confirm/.test(w)), [true, true]);

    part("The developers page says what the door now answers");
    const page = readFileSync("app/developers/page.tsx", "utf8").replace(/\s+/g, " ");
    const paused = page.slice(page.indexOf("Adding a lead, adding labels"), page.indexOf("as usual.", page.indexOf("Adding a lead, adding labels")));
    is("its list of writes the unpaid pause stops names discount codes made or switched off", /making or switching off a discount code/.test(paused), true);
    is("and an AI assistant's prepared change, refused with the same message", /propose_product_description/.test(paused), true);
    is("a paused key is no longer said to hear 403 on every request", page.includes("Every request with it is answered 403"), false);
    is("past its minute a paused key is said to hear 429 like any key", /past that, it hears 429 <code className="font-mono">rate_limited<\/code> like any key/i.test(page), true);
    // Rule 23: on the RED commit this read the flattened page, where the code block's two spaces are one, so it could
    // never pass; it reads the file as written, as tests/api-key-second-step.test.ts does for 403 key_paused.
    is("a minute's count that cannot be read is listed as 503 unavailable", readFileSync("app/developers/page.tsx", "utf8").includes('503  {"error": "unavailable", "message": "The store could not answer just now. Try again in a moment."}'), true);

    part("A key past its minute costs only its lookup and the counter, paused or live");
    const fourth = await storeOf("guard-limits-cost@example.com", "guard-limits-cost", "GuardLimitsCost");
    const gone = await makeKey(fourth.sid, "Gone sync", Date.now(), false, "none", { owner: false, by: "", step: false, left: true });
    const live = await makeKey(fourth.sid, "Live sync", Date.now(), false);
    if (!gone.ok || !live.ok) throw new Error("No synthetic key");
    const realPipeline = redis.pipeline.bind(redis);
    let sent: string[] = [];
    let counterDown = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      sent.push(...commands.map((c) => String(c[0])));
      if (counterDown && commands.length === 2 && commands[0]?.[0] === "SET" && commands[1]?.[0] === "INCR") throw new Error("Synthetic counter out of reach");
      return realPipeline(commands);
    }) as typeof redis.pipeline;
    try {
      const costOf = async (key: string) => {
        sent = [];
        const answer = await ask(products, key, "/api/v1/products");
        return { status: answer.status, error: answer.body.error, commands: sent.length, sent: [...sent] };
      };
      const pausedCost = await costOf(gone.key);
      is("control: a paused key inside its minute is told it is paused", [pausedCost.status, pausedCost.error], [403, "key_paused"]);
      for (let i = 1; i < API_RATE; i += 1) await ask(products, gone.key, "/api/v1/products");
      const pausedPast = await costOf(gone.key);
      is("a paused key past its minute hears 429", [pausedPast.status, pausedPast.error], [429, "rate_limited"]);
      // Measured: on 658ce32c00 a paused key past its minute cost 7 commands (GET, the four reads, SET, INCR).
      is(`and costs at most ${KEY_PAST_MINUTE_COMMANDS} commands: the lookup and the counter`, [pausedPast.commands <= KEY_PAST_MINUTE_COMMANDS, pausedPast.sent], [true, ["GET", "SET", "INCR"]]);
      for (let i = 0; i < API_RATE; i += 1) await ask(products, live.key, "/api/v1/products");
      const livePast = await costOf(live.key);
      is("a live key past its minute hears 429", [livePast.status, livePast.error], [429, "rate_limited"]);
      is(`and costs at most ${KEY_PAST_MINUTE_COMMANDS} commands too`, [livePast.commands <= KEY_PAST_MINUTE_COMMANDS, livePast.sent], [true, ["GET", "SET", "INCR"]]);
      const unknownKey = await costOf(`${gone.key.slice(0, -1)}${gone.key.endsWith("0") ? "1" : "0"}`);
      is("an unknown key still hears 401 after its lookup alone", [unknownKey.status, unknownKey.error, unknownKey.sent], [401, "unauthorized", ["GET"]]);
      redis.advance(61_000);
      counterDown = true;
      const unread = await costOf(gone.key);
      counterDown = false;
      is("a counter that cannot be read refuses the paused key with 503, not 429 or its pause", [unread.status, unread.error], [503, "unavailable"]);
      is("after the lookup and the counter, nothing more is read", unread.sent, ["GET", "SET", "INCR"]);
      const back = await costOf(gone.key);
      is("with the counter back, the paused key is told it is paused", [back.status, back.error], [403, "key_paused"]);
    } finally {
      redis.pipeline = realPipeline;
    }

    // Last, since the stand-in's clock stays where it is moved.
    redis.advance(61_000);
    is("a minute later the paused key is told it is paused again", (await ask(products, left.key, "/api/v1/products")).body.error, "key_paused");
    is("nothing outside was reached", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
