/**
 * A person's copy of the payments a closing store kept for them reads only their own rows (#5125, coordinator 6a9d,
 * 22 November 2026): the hold writes each member's last payment and its place in the closing's index by address in
 * one script (lib/closing-holds.ts, PAID_HOLD), and heldPaymentsOf reads the person's index entry and those rows, never
 * the store's whole hash, which holds a row for every member held. The address is compared and hashed the same way,
 * so capitals and spaces find the same rows; a reply that does not read is unknown; forgetHeld deletes the index with
 * the rows; and the index's commands and bytes are in the closing's cost (tests/plan-cost-registry.ts). Checked against
 * the stand-in Redis and a stand-in Stripe; nothing real is reached.
 */
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setStripeAccount, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { PAID_HOLD, forgetHeld, heldAddressField, heldPaymentsOf, paidByKey, paidKey, retryHolds, workKey } from "@/lib/closing-holds";
import { CLOSING_PAID_INDEX_BYTES, CLOSING_PAID_INDEX_COMMANDS, closingBuyersCost } from "./plan-cost-registry";
import { buyerNoticeCap } from "@/lib/closing-buyers-rules";
import { erasePerson } from "@/lib/person-erasure";

process.env.STRIPE_SECRET_KEY = "sk_test_closing_held_index_only";

const ACCOUNT = "acct_1ClosingHeldIx";
const HANDLE = "closing-held-index";
const ENDED_AT = Date.UTC(2026, 9, 1, 12);
const PE = Math.floor(ENDED_AT / 1000) + 20 * 86_400;
/** Two memberships of Ada (her address on Stripe with capitals and spaces), one of Bob. */
const MEMBERS: Record<string, string> = { sub_HeldIndexAda001: "  Ada@Example.COM ", sub_HeldIndexAda002: "ada@example.com", sub_HeldIndexBob001: "bob@example.com" };
const writes: string[] = [];

const paidInvoice = (sub: string) => ({
  id: `in_${sub.slice(4)}`, status: "paid", amount_paid: 2_000, subtotal: 2_000, total: 2_000, currency: "usd", payment_intent: `pi_${sub.slice(4)}`,
  lines: { data: [{ type: "subscription", proration: false, amount: 2_000, discount_amounts: [], period: { start: PE - 30 * 86_400, end: PE } }] },
  subscription: sub, customer: `cus_${sub.slice(4)}`,
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method !== "GET") {
    writes.push(`${method} ${path}`);
    return json({ id: path.split("/").pop() });
  }
  const sub = path.startsWith("/subscriptions/") ? path.slice("/subscriptions/".length) : "";
  if (sub in MEMBERS) return json({ id: sub, status: "active", metadata: { store: HANDLE }, customer: { id: `cus_${sub.slice(4)}`, email: MEMBERS[sub] } });
  if (path === "/invoices") {
    const asked = url.searchParams.get("subscription") ?? "";
    return json({ object: "list", data: url.searchParams.get("status") === "paid" && asked in MEMBERS ? [paidInvoice(asked)] : [], has_more: false });
  }
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A store closing with its three members held through the real hold, and `others` rows of other members beside them. */
async function closing(others = 0) {
  redis.clear();
  writes.length = 0;
  const email = "closing-held-index@example.com";
  await claimHandle(email, HANDLE, "Closing held index", "");
  await setStripeAccount(email, ACCOUNT, true);
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  await redis.pipeline([["HSET", workKey(folder), "calls", 1_000, ...Object.keys(MEMBERS).flatMap((sub) => [`f:${sub}`, "1", `m:${sub}`, MEMBERS[sub].trim().toLowerCase()])]]);
  await retryHolds(store, ENDED_AT, Date.now() + 10_000);
  // Other members' rows, each with its own address and its place in the index, as the hold writes them.
  for (let i = 0; i < others; i += 1) {
    const sub = `sub_HeldIndexOther${String(i).padStart(4, "0")}`, e = `member${i}@example.com`;
    const row = JSON.stringify({ inv: `in_HeldIndexOther${i}`, amt: 1000, tot: 1000, cur: "usd", ps: PE - 30 * 86_400, pe: PE, e });
    await redis.pipeline([["HSET", paidKey(folder), sub, row], ["HSET", paidByKey(folder), heldAddressField(e), sub]]);
  }
  return { store, folder };
}

/** Runs `run` while recording every command sent, and answers the ones `answer` picks. */
async function watched<T>(run: () => Promise<T>, answer?: (command: unknown[]) => { reply: unknown } | undefined) {
  const real = redis.pipeline.bind(redis);
  const sent: unknown[][] = [];
  redis.pipeline = (async (commands: unknown[][]) => {
    sent.push(...commands);
    const replies = await real(commands as never);
    return commands.map((command, i) => {
      const forced = answer?.(command);
      return forced ? forced.reply : (replies as unknown[])[i];
    });
  }) as typeof redis.pipeline;
  try {
    return { out: await run(), sent };
  } finally {
    redis.pipeline = real;
  }
}
const outcome = async (run: () => Promise<unknown>) => {
  try {
    const out = await run();
    return Array.isArray(out) ? `rows:${out.length}` : JSON.stringify(out);
  } catch {
    return "unknown";
  }
};

async function main() {
  part("The hold writes each row with its place in the member's index, in one script");
  {
    const { folder } = await closing();
    is("the three members are held", Object.keys(MEMBERS).every((sub) => writes.includes(`POST /subscriptions/${sub}`)), true);
    const index = await redis.run(["HGETALL", paidByKey(folder)]);
    is("Ada's two memberships under one field, Bob's under another", index, [heldAddressField("ada@example.com"), "sub_HeldIndexAda001,sub_HeldIndexAda002", heldAddressField("bob@example.com"), "sub_HeldIndexBob001"]);
    is("the field never names the address", JSON.stringify(index).includes("ada@"), false);
  }

  part("A person's copy holds every row of theirs and none of anyone else's, without reading the store's whole hash");
  {
    const { store, folder } = await closing(250);
    for (const asked of ["ada@example.com", " ADA@example.com ", "Ada@Example.Com"]) {
      const { out, sent } = await watched(() => heldPaymentsOf(store, asked));
      is(`asked as ${JSON.stringify(asked)}: Ada's two payments`, out.map((row) => row.subscription).sort(), ["sub_HeldIndexAda001", "sub_HeldIndexAda002"]);
      is(`asked as ${JSON.stringify(asked)}: the store's whole hash is never read`, sent.some((c) => c[1] === paidKey(folder) && c[0] !== "HMGET"), false);
      is(`asked as ${JSON.stringify(asked)}: only Ada's rows are asked for`, sent.filter((c) => c[0] === "HMGET").map((c) => c.slice(2)), [["sub_HeldIndexAda001", "sub_HeldIndexAda002"]]);
    }
    is("Bob's one payment", (await heldPaymentsOf(store, "bob@example.com")).map((row) => [row.subscription, row.inv]), [["sub_HeldIndexBob001", "in_HeldIndexBob001"]]);
    is("a person the closing never held: nothing", await heldPaymentsOf(store, "nobody@example.com"), []);
    is("another member: their one payment", (await heldPaymentsOf(store, "member7@example.com")).map((row) => row.subscription), ["sub_HeldIndexOther0007"]);
  }

  part("Every reply the copy reads is read exactly; a row Redis says is not there is none");
  {
    const { store, folder } = await closing();
    const field = heldAddressField("ada@example.com");
    const isIndex = (c: unknown[]) => c[0] === "HGET" && c[1] === paidByKey(folder) && c[2] === field;
    const isRows = (c: unknown[]) => c[0] === "HMGET" && c[1] === paidKey(folder);
    for (const [what, pick, reply] of [
      ["the index answers a number", isIndex, 42],
      ["the index answers an empty text", isIndex, ""],
      ["the index lists something that is not a subscription", isIndex, "sub_HeldIndexAda001,cs_test_x"],
      ["the index lists a subscription twice", isIndex, "sub_HeldIndexAda001,sub_HeldIndexAda001"],
      ["the rows answer text", isRows, "OK"],
      ["the rows answer one row too many", isRows, [null, null, null]],
      ["a row is not JSON", isRows, ["{cut short", null]],
      ["a row has no amount", isRows, [JSON.stringify({ inv: "in_x", e: "ada@example.com" }), null]],
      ["a row is a number", isRows, [7, null]],
    ] as const) {
      const { out } = await watched(() => outcome(() => heldPaymentsOf(store, "ada@example.com")), (c) => (pick(c) ? { reply } : undefined));
      is(`${what}: the copy is not made`, out, "unknown");
    }
    const { out } = await watched(() => outcome(() => heldPaymentsOf(store, "ada@example.com")), (c) => (isRows(c) ? { reply: [null, null] } : undefined));
    is("rows Redis says are not there: none, never unknown", out, "rows:0");
  }

  part("A write of the row and its index that does not answer 1 or 0 never counts the member held");
  {
    redis.clear();
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: unknown[][]) => {
      const replies = (await real(commands as never)) as unknown[];
      return commands.map((c, i) => (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:closing-paid-hold:v1\n") ? "OK" : replies[i]));
    }) as typeof redis.pipeline;
    let work = "";
    try {
      writes.length = 0;
      const email = "closing-held-index@example.com";
      await claimHandle(email, HANDLE, "Closing held index", "");
      await setStripeAccount(email, ACCOUNT, true);
      const store = (await storeForEmail(email))!;
      work = workKey(await storeFolder(storeRef(store)));
      await real([["HSET", work, "calls", 1_000, "f:sub_HeldIndexAda001", "1"]] as never);
      await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    } finally {
      redis.pipeline = real;
    }
    is("the member is not paused", writes.includes("POST /subscriptions/sub_HeldIndexAda001"), false);
    is("and is tried again", await redis.run(["HEXISTS", work, "f:sub_HeldIndexAda001"]), 1);
  }

  part("Deleting the person keeps the rows the closing owes them, and the index that finds them (coordinator 19db)");
  {
    const { store, folder } = await closing();
    const erased = await erasePerson(store, "ada@example.com", { kind: "person" });
    is("the person is deleted", erased.ok, true);
    is("their kept payments are still in their copy", (await heldPaymentsOf(store, "ada@example.com")).map((row) => row.subscription).sort(), ["sub_HeldIndexAda001", "sub_HeldIndexAda002"]);
    is("and the index still names them", await redis.run(["HGET", paidByKey(folder), heldAddressField("ada@example.com")]), "sub_HeldIndexAda001,sub_HeldIndexAda002");
  }

  part("forgetHeld deletes the index with the rows, in the same command");
  {
    const { store, folder } = await closing();
    const { sent } = await watched(() => forgetHeld(store, folder));
    const del = sent.find((c) => c[0] === "DEL" && c.includes(paidKey(folder)));
    is("one DEL names the rows and the index", Boolean(del && del.includes(paidByKey(folder))), true);
    is("nothing of either is left", [await redis.run(["EXISTS", paidKey(folder)]), await redis.run(["EXISTS", paidByKey(folder)])], [0, 0]);
  }

  part("The index's commands and bytes are in the closing's cost");
  {
    // A script is billed 1 for the EVAL and 1 for each call inside it; it replaced one HSETNX (the rule of PAYPAL_PRESS_COMMANDS).
    const calls = PAID_HOLD.split("redis.call(").length - 1;
    is("the script's calls are three, all priced beyond the HSETNX it replaced", [calls, calls], [3, CLOSING_PAID_INDEX_COMMANDS]);
    // The address's hash, a comma and the longest subscription id the code accepts (sub_ and 64 characters).
    is("one member's entry fits its priced bytes", 64 + 1 + 4 + 64 <= CLOSING_PAID_INDEX_BYTES, true);
    const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
    const line = registry.slice(registry.indexOf("export const CLOSING_BUYER_COST ="), registry.indexOf("export const CLOSING_PAYPAL_PAGE"));
    is("CLOSING_BUYER_COST counts both", ["CLOSING_PAID_INDEX_BYTES", "CLOSING_PAID_INDEX_COMMANDS"].every((name) => line.includes(name)), true);
  }

  part("The funded-exposure review's table of one closing's ceiling is the model's (coordinator 19db)");
  {
    const review = readFileSync("docs/funded-exposure-review.md", "utf8");
    for (const [label, tier, paid] of [["Store", "creator", true], ["Studio", "pro", true], ["Scale", "scale", true], ["A store that never paid", "creator", false]] as const) {
      const row = review.split("\n").find((line) => line.startsWith(`| ${label} |`));
      const want = `| ${label} | ${buyerNoticeCap(tier, paid).toLocaleString("en-US")} | $${closingBuyersCost(tier, paid).toFixed(2)} |`;
      is(`${label}: buyers at the cap and the ceiling`, row, want);
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
