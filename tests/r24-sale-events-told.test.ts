/**
 * CX-123 rule 24, lib/sale-events.ts noteSales (audit r24 round 5, finding 4): a paid checkout is told once. The
 * "told already?" EXISTS is read exactly: 1 skips, 0 goes on to claim the sale's own mark with claimMark
 * (lib/claim-mark.ts), and only a claim that is ours tells. Anything else (a count in another shape, a pipeline cut
 * short, a claim answered in another shape whose write did not land) tells nothing and records nothing, so the same
 * purchase is never shown twice in the store's "recent purchases" block (lib/recent-sales.ts, no dedupe) and the
 * "New sale" line never goes twice to the team's Slack or Discord (postToChat keeps no mark of its own). A sale left
 * unknown is told on a later pass, once.
 *
 * Replies the stand-in never gives by itself are injected for one pipeline: "only" means the command never reached
 * Redis (the write did not land), "after" means it ran and the answer came back in another shape.
 */
import { noteSales, type SaleRecord } from "@/lib/sale-events";
import { setChatAddress } from "@/lib/chat-summary";
import { type Store, claimHandle, ensureStatsId, setChatSales, setRecentSales, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_r24_sale_events_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "r24-sales-owner@example.com";
const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";
const TOLD_SECONDS = 40 * 86400;
const posted: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "hooks.slack.com") {
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response("ok", { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Commands = (string | number)[][];
const startsWith = (commands: Commands, name: string, prefix: string) =>
  commands[0]?.[0] === name && String(commands[0]?.[1] ?? "").startsWith(prefix);

/** The first pipeline whose first command is `name` on a key starting `prefix` never reaches Redis; `reply` is all there is. */
async function withReplyOnly<T>(name: string, prefix: string, reply: unknown, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!used && startsWith(commands, name, prefix)) {
      used = true;
      return reply;
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

/** Like withReplyOnly, but the command ran: the write landed and only the answer is in another shape. */
async function withReplyAfter<T>(name: string, prefix: string, reply: unknown, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: Commands) => {
    const answer = await real(commands);
    if (!used && startsWith(commands, name, prefix)) {
      used = true;
      return reply;
    }
    return answer;
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

/** Every pipeline whose first command is `name` on a key starting `prefix` fails as a request. */
async function withFailing<T>(name: string, prefix: string, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Commands) => {
    if (startsWith(commands, name, prefix)) throw new Error("redis down (synthetic)");
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

let serial = 0;
/** A settled live checkout of one product, paid with real money, so the recent-purchases block takes it. */
function sale(): SaleRecord & { id: string } {
  serial += 1;
  const n = String(serial).padStart(4, "0");
  return {
    id: `cs_live_r24sale${n}${"a".repeat(12)}`,
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 2_900,
    currency: "usd",
    created: Math.floor(Date.now() / 1000) - 60,
    payment_intent: `pi_r24sale${n}abcdef`,
    customer_details: { email: "buyer@example.com", name: "Pat Buyer", address: { country: "DE" } },
    metadata: { store: "r24sales", product: "p_r24", title: "Weeknight Club", channel: "instagram" },
  };
}

async function freshStore(): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "r24sales", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestR24Sale", true);
  await setSubscription(OWNER, { customerId: "cus_R24Sale0001", subscriptionId: "sub_R24Sale0001", active: true, period: paidPeriod() });
  let store = (await storeForEmail(OWNER))!;
  await setChatAddress(store.statsId!, "Harbor Kitchen", SLACK);
  await setChatSales(OWNER, true);
  await setRecentSales(OWNER, true);
  store = (await storeForEmail(OWNER))!;
  posted.length = 0;
  return store;
}

const shown = (store: Store) => redis.run(["LLEN", `nl:recent:${store.statsId}`]);
const marked = (record: { id: string }) => redis.run(["EXISTS", `nl:sale:told:${record.id}`]);

/** noteSales, with what it threw (if anything) kept for the check. */
async function settle(run: () => Promise<number>): Promise<{ told: number | null; threw: string }> {
  try {
    return { told: await run(), threw: "" };
  } catch (error) {
    return { told: null, threw: error instanceof Error ? error.name : String(error) };
  }
}

async function main(): Promise<void> {
  part("Healthy: told once, the mark kept 40 days");
  {
    const store = await freshStore();
    const record = sale();
    is("told", await noteSales(store, [record]), 1);
    is("one chat line, never who", posted, ["New sale on Harbor Kitchen: $29, Weeknight Club (from Instagram)"]);
    is("one recent purchase", shown(store), 1);
    is("the mark written", marked(record), 1);
    const ttl = Number(redis.run(["TTL", `nl:sale:told:${record.id}`]));
    is("for 40 days", ttl > TOLD_SECONDS - 60 && ttl <= TOLD_SECONDS, true);
    is("a second pass tells nothing", await noteSales(store, [record]), 0);
    is("still one chat line and one recent purchase", [posted.length, shown(store)], [1, 1]);
  }

  part("The 'told already?' answer in an unknown shape: nothing told, nothing recorded");
  const slotShapes: [string, unknown][] = [
    ["a string '1'", "1"],
    ["a string '0'", "0"],
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["a list", [1]],
    ["two", 2],
    ["minus one", -1],
    ["a fraction", 0.5],
    ["NaN", Number.NaN],
  ];
  for (const [label, slot] of slotShapes) {
    const store = await freshStore();
    const record = sale();
    const outcome = await settle(() => withReplyOnly("EXISTS", "nl:sale:told:", [slot], () => noteSales(store, [record])));
    is(`EXISTS answered ${label}: not told`, outcome.told ?? 0, 0);
    is(`EXISTS answered ${label}: said as unknown`, outcome.threw, "UnknownReplyError");
    is(`EXISTS answered ${label}: no chat line, no recent purchase, no mark`, [posted.length, shown(store), marked(record)], [0, 0, 0]);
    is(`EXISTS answered ${label}: told once on the next healthy pass`, await noteSales(store, [record]), 1);
    is(`EXISTS answered ${label}: one chat line and one recent purchase`, [posted.length, shown(store)], [1, 1]);
  }
  const pipelineShapes: [string, unknown][] = [
    ["no reply", []],
    ["an extra reply", [0, 0]],
    ["null", null],
    ["undefined", undefined],
    ["text", "x"],
    ["an object", { 0: 0, length: 1 }],
  ];
  for (const [label, reply] of pipelineShapes) {
    const store = await freshStore();
    const record = sale();
    const outcome = await settle(() => withReplyOnly("EXISTS", "nl:sale:told:", reply, () => noteSales(store, [record])));
    is(`the EXISTS pipeline answered ${label}: refused as unknown`, outcome, { told: null, threw: "UnknownReplyError" });
    is(`the EXISTS pipeline answered ${label}: no chat line, no recent purchase, no mark`, [posted.length, shown(store), marked(record)], [0, 0, 0]);
  }

  part("One unknown answer in a batch leaves only that sale for later");
  {
    const store = await freshStore();
    const [first, second, third] = [sale(), sale(), sale()];
    const outcome = await settle(() => withReplyOnly("EXISTS", "nl:sale:told:", [0, "1", 0], () => noteSales(store, [first, second, third])));
    is("the batch said as not wholly done", outcome.threw, "UnknownReplyError");
    is("the two readable sales told, the unknown one not", [marked(first), marked(second), marked(third)], [1, 0, 1]);
    is("two chat lines, two recent purchases", [posted.length, shown(store)], [2, 2]);
    is("the next pass tells only the one left", await noteSales(store, [first, second, third]), 1);
    is("three of each, none twice", [posted.length, shown(store)], [3, 3]);
  }

  part("The claim answered in another shape");
  for (const [label, reply] of [["queued", ["QUEUED"]], ["no reply", []], ["undefined", [undefined]], ["a count", [1]], ["an extra reply", ["OK", "OK"]]] as [string, unknown][]) {
    const store = await freshStore();
    const record = sale();
    const outcome = await settle(() => withReplyOnly("SET", "nl:sale:told:", reply, () => noteSales(store, [record])));
    is(`the claim answered ${label}, not written: not told`, [outcome.told ?? 0, posted.length, shown(store), marked(record)], [0, 0, 0, 0]);
    is(`the claim answered ${label}, not written: told once on the next pass`, [await noteSales(store, [record]), posted.length, shown(store)], [1, 1, 1]);
  }
  {
    const store = await freshStore();
    const record = sale();
    await withReplyAfter("SET", "nl:sale:told:", ["QUEUED"], () => noteSales(store, [record]));
    is("answered in another shape but written: ours, told once", [posted.length, shown(store), marked(record)], [1, 1, 1]);
    is("and never twice", [await noteSales(store, [record]), posted.length, shown(store)], [0, 1, 1]);
  }

  part("Two places noticing the same checkout at once tell it once");
  {
    const store = await freshStore();
    const record = sale();
    // The other place told it between this pass's EXISTS (0) and its claim.
    redis.run(["SET", `nl:sale:told:${record.id}`, "1", "EX", TOLD_SECONDS]);
    is("the claim is the other's: not told", await withReplyOnly("EXISTS", "nl:sale:told:", [0], () => noteSales(store, [record])), 0);
    is("no chat line, no recent purchase", [posted.length, shown(store)], [0, 0]);
  }

  part("A telling that fails lets its own mark go, so the next pass tells it");
  {
    const base = await freshStore();
    const record = sale();
    // A catalog held in its own records, whose listing read fails as a request: tell() throws before telling anything.
    const store = { ...base, catalog: { ...base.catalog, inline: null, head: [], id: "cat_r24", items: [{ id: "p_r24" }] } } as unknown as Store;
    const outcome = await settle(() => withFailing("GET", "nl:catalog:cat_r24:", () => noteSales(store, [record])));
    is("the failure is said", outcome.told, null);
    is("nothing told and no mark kept", [posted.length, shown(base), marked(record)], [0, 0, 0]);
    is("told once on the next pass", [await noteSales(base, [record]), posted.length, shown(base)], [1, 1, 1]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
