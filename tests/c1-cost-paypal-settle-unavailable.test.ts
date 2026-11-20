/**
 * "Check with PayPal" said "PayPal was asked less than a minute ago. Try again in a minute." for every reading that
 * asked PayPal nothing (Codex X4 and X6 on #4212, MEDIUM): also when no PayPal token could be had (the mark is let go,
 * so a new try asks at once) and when the pace mark could not be confirmed. Neither was a recent question to PayPal.
 *
 * What is checked, with a synthetic stand-in for PayPal whose batch stays PENDING:
 *   - a press whose token fails says it could not check (`unavailable`), and the next press asks PayPal at once;
 *   - a press whose mark cannot be confirmed says the same, and asks nothing;
 *   - a second press within the minute is still the one-minute wait, not `unavailable`;
 *   - the button shows the "could not check" sentence for `unavailable`, before the one-minute one.
 */
import { readFileSync } from "node:fs";
import { connectPayPal, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { claimMark, releaseMark } from "@/lib/claim-mark";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { markLive } from "./live-store";
import { done, is, part } from "./check";

const STATS = "statsunav01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";

let tokens = 0;
let tokenDown = false;
let reads = 0;
const items = new Map<string, string>();
let batches = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") {
    tokens += 1;
    if (tokenDown) return json({ error: "invalid_client" }, 401);
    return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
  }
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { sender_batch_header: { sender_batch_id: string }; items: { sender_item_id: string }[] };
    batches += 1;
    const id = `BATCH${batches}PACE`;
    for (const item of body.items) items.set(`${id}:${item.sender_item_id}`, "PENDING");
    return json({ batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+PACE)$/.exec(url.pathname)?.[1];
  if (batch) {
    reads += 1;
    const mine = [...items.entries()].filter(([k]) => k.startsWith(`${batch}:`));
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "PENDING" },
      total_pages: 1,
      items: mine.map(([k, status], i) => ({ payout_item_id: `ITEM${batch}${i}`, payout_batch_id: batch, transaction_status: status, payout_item: { sender_item_id: k.split(":")[1] } })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidunav0001", handle: "unavpaypal", name: "Pace Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestPace00001", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_pace_only";
  console.error = () => {};
  redis.clear();
  const store = shop();
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
  ]);
  await markLive(store);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
  const paid = await payWithPayPal(store);
  if (!paid.ok) throw new Error(`not sent: ${JSON.stringify(paid)}`);
  is("one batch is on its way, PENDING at PayPal", batches, 1);

  part("A press whose token fails says it could not check, and the next press asks at once");
  await redis.pipeline([["DEL", `nl:pp:pace:${STATS}`, `nl:pp:press:${STATS}`]]);
  tokens = 0;
  reads = 0;
  tokenDown = true;
  const down = await settlePayPal(store, { press: true });
  tokenDown = false;
  is("PayPal was not asked, and the reading says it could not check", [down.asked, down.unavailable, down.waiting, reads], [false, true, 1, 0]);
  const next = await settlePayPal(store, { press: true });
  is("the next press gets a token and reads the batch at once", [next.asked !== false, next.unavailable === true, tokens, reads], [true, false, 2, 1]);

  part("A second press within the minute is still the one-minute wait");
  const again = await settlePayPal(store, { press: true });
  is("held back by its own mark, not unavailable", [again.asked, again.unavailable === true, tokens], [false, false, 2]);

  part("A press whose mark cannot be confirmed asks nothing and says it could not check");
  await redis.pipeline([["DEL", `nl:pp:pace:${STATS}`, `nl:pp:press:${STATS}`]]);
  tokens = 0;
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: (string | number)[][]) => {
    if (batch[0]?.[0] === "SET" && String(batch[0]?.[1]).startsWith("nl:pp:")) throw new Error("synthetic lost SET NX");
    if (batch[0]?.[0] === "GET" && String(batch[0]?.[1]).startsWith("nl:pp:")) return [{ odd: true }];
    return real(batch);
  }) as typeof redis.pipeline;
  const unknownPress = await settlePayPal(store, { press: true });
  const unknownView = await settlePayPal(store, { paced: true });
  redis.pipeline = real as typeof redis.pipeline;
  is("no token asked, and both say they could not check", [tokens, unknownPress.asked, unknownPress.unavailable, unknownView.unavailable], [0, false, true, true]);

  part("A release that is not confirmed is said so, and no try is promised at once (Codex L on #4212, MEDIUM)");
  {
    // The mark is let go by one compare-and-delete script; when its answer is lost the mark stays until it runs out
    // (lib/redis-lock.ts, releaseLock), so the next press would find it taken and ask PayPal nothing.
    const lostRelease = async (batch: (string | number)[][]) => {
      if (batch[0]?.[0] === "EVAL" && String(batch[0]?.[1]).startsWith("-- marktmorgen:release:v1") && String(batch[0]?.[3]).startsWith("nl:pp:")) {
        await real(batch);
        return [{ odd: true }];
      }
      return real(batch);
    };
    await redis.pipeline([["DEL", "nl:test:release"]]);
    is("a mark taken for the check", await claimMark("nl:test:release", 60, "mine"), "ours");
    is("a confirmed release says true", await releaseMark("nl:test:release", "mine"), true);
    is("a release of a mark held by another says false", [await claimMark("nl:test:release", 60, "theirs"), await releaseMark("nl:test:release", "mine")], ["ours", false]);
    await redis.pipeline([["DEL", `nl:pp:pace:${STATS}`, `nl:pp:press:${STATS}`, "nl:test:release"]]);
    tokenDown = true;
    redis.pipeline = lostRelease as typeof redis.pipeline;
    const unsure = await settlePayPal(store, { press: true });
    redis.pipeline = real as typeof redis.pipeline;
    tokenDown = false;
    is("no token, release not confirmed: could not check, and no try at once", [unsure.asked, unsure.unavailable, unsure.retryNow === true], [false, true, false]);
    await redis.pipeline([["DEL", `nl:pp:pace:${STATS}`, `nl:pp:press:${STATS}`]]);
    tokenDown = true;
    const sure = await settlePayPal(store, { press: true });
    tokenDown = false;
    is("no token, release confirmed: could not check, and a try at once", [sure.unavailable, sure.retryNow], [true, true]);
    redis.pipeline = (async (batch: (string | number)[][]) => {
      if (batch[0]?.[0] === "SET" && String(batch[0]?.[1]).startsWith("nl:pp:")) throw new Error("synthetic lost SET NX");
      if (batch[0]?.[0] === "GET" && String(batch[0]?.[1]).startsWith("nl:pp:")) return [{ odd: true }];
      return real(batch);
    }) as typeof redis.pipeline;
    await redis.pipeline([["DEL", `nl:pp:pace:${STATS}`, `nl:pp:press:${STATS}`]]).catch(() => undefined);
    const unknownMark = await settlePayPal(store, { press: true });
    redis.pipeline = real as typeof redis.pipeline;
    is("a mark that could not be confirmed: could not check, and no try at once", [unknownMark.unavailable, unknownMark.retryNow === true], [true, false]);
  }

  part("The button tells the two apart");
  const button = readFileSync("components/paypal-payouts.tsx", "utf8");
  const couldNot = button.indexOf("data.unavailable");
  const minute = button.indexOf("PayPal was asked less than a minute ago.");
  is("an unavailable reading has its own sentence, read before the one-minute wait", [couldNot > 0, minute > couldNot, button.includes("We could not check these payments with PayPal just now. Nothing was asked of PayPal, so you can try again right away.")], [true, true, true]);
  is("try again right away only when the reading says so; otherwise in a minute", [button.includes("data.retryNow"), button.includes("We could not check these payments with PayPal just now. Nothing was asked of PayPal. Try again in a minute.")], [true, true]);
  done();
}

void main().catch((error) => {
  console.error = (...args: unknown[]) => process.stderr.write(`${args.join(" ")}\n`);
  console.error(error);
  process.exitCode = 2;
});
