/**
 * The deals page's table by channel (components/deal-channels-table.tsx)
 * reads the store's buyers (lib/segments.ts buyerLedger): the ten-minute copy
 * by its size and, when the copy is gone, Stripe again. Like the buyers page
 * (lib/person-agenda-read.ts countLedger), it counts that reading in the
 * studio's requests before it reads, and when it is not counted, nothing more
 * is read and the table says so in plain words (MR: a ceiling before every
 * spend). Synthetic store, synthetic copy, Stripe stubbed; nothing real.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DealChannelsLoader } from "@/components/deal-channels-table";
import { DEFAULT_STAGES } from "@/lib/crm-rules";
import { BUYER_LEDGER_UNITS, buyerLedger, ledgerUnits } from "@/lib/segments";
import { PAGE_INCLUDED_BYTES } from "@/lib/sent-bytes";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { windowId } from "@/lib/allowance-window";
import { type Store, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "deal-channels-owner@example.com";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.stripe.com") stripeCalls += 1;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const rows = Array.from({ length: 1500 }, (_, i) => [`buyer${String(i).padStart(5, "0")}@example.com`, 1200, 1, "direct", 1]);
const pipeline = redis.pipeline.bind(redis);

async function shop(): Promise<Store> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_deal_channels_only_a_stand_in";
  await claimHandle(OWNER, "dealchannels", "Deal Channels", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestDealChan01", true);
  await setSubscription(OWNER, { customerId: "cus_dealch", subscriptionId: "sub_dealch", active: true, tier: "pro", period: paidPeriod() });
  return { ...(await storeForEmail(OWNER))!, pastBuyers: true };
}

const ledgerKey = (store: Store) => `nl:stats:${store.statsId}:ledger`;
const copyOf = (store: Store) => JSON.stringify({ c: store.currency, p: false, r: rows, v: 6 });

const counterOf = (store: Store) => redis.keys().find((key) => key.startsWith("nl:allow:studio:") && key.endsWith(`:${windowId(store)}`));
const used = async (store: Store) => {
  const key = counterOf(store);
  return key ? Number((await pipeline([["GET", key]]))[0] ?? 0) : 0;
};

/** Runs `run` with every Redis command it sends written down, in order. */
async function traced<T>(run: () => Promise<T>) {
  const commands: string[] = [];
  redis.pipeline = (async (batch: (string | number)[][]) => {
    commands.push(...batch.map((row) => row.join(" ").slice(0, 80)));
    return pipeline(batch);
  }) as typeof redis.pipeline;
  try {
    return { value: await run(), commands };
  } finally {
    redis.pipeline = pipeline;
  }
}

const loaded = async (store: Store) => {
  const { value, commands } = await traced(() => DealChannelsLoader({ store, deals: [], stages: DEFAULT_STAGES }));
  return { html: renderToStaticMarkup(value), commands };
};
const at = (commands: string[], start: string) => commands.findIndex((c) => c.startsWith(start));

test("the copy is bigger than one studio request's included bytes", async () => {
  assert.ok(Buffer.byteLength(copyOf(await shop())) > PAGE_INCLUDED_BYTES);
});

test("control: the buyers page's reading asks the studio requests before the copy is read", async () => {
  const store = await shop();
  await pipeline([["SET", ledgerKey(store), copyOf(store), "EX", 600]]);
  const charged: number[] = [];
  const value = await buyerLedger(store, async (units) => { charged.push(units); return true; });
  assert.equal(value.buyers.size, 1500);
  assert.deepEqual(charged, [ledgerUnits(Buffer.byteLength(copyOf(store)))]);
});

test("the deals page counts the copy's reading in the studio's requests before it reads it", async () => {
  const store = await shop();
  await pipeline([["SET", ledgerKey(store), copyOf(store), "EX", 600]]);
  const before = await used(store);
  const { html, commands } = await loaded(store);
  const counted = commands.findIndex((c) => c.startsWith("INCRBY nl:allow:studio:"));
  const read = at(commands, `GETRANGE ${ledgerKey(store)}`);
  assert.deepEqual({ counted: counted >= 0, read: read >= 0, countedFirst: counted < read, units: (await used(store)) - before, stripeCalls }, { counted: true, read: true, countedFirst: true, units: ledgerUnits(Buffer.byteLength(copyOf(store))), stripeCalls: 0 }, commands.join("\n"));
  assert.ok(html.includes("No deals yet"), html);
});

test("with the studio's requests used up, the copy is not read and the page says why", async () => {
  const store = await shop();
  await pipeline([["SET", ledgerKey(store), copyOf(store), "EX", 600]]);
  // Take one request so the month's counter exists, then fill it.
  await traced(async () => (await import("@/lib/studio-route")).countStudio(store, null, 1));
  await pipeline([["SET", counterOf(store)!, String(allowanceFor(store, "studio"))]]);
  const { html, commands } = await loaded(store);
  assert.equal(at(commands, `GETRANGE ${ledgerKey(store)}`), -1, commands.join("\n"));
  assert.ok(!html.includes("could not be read just now"), html);
  assert.ok(/studio requests|studio&#x27;s requests/i.test(html), html);
  assert.ok(html.includes('role="status"'), html);
});

test("with no copy kept, Stripe is read only after its reading is counted, and not at all when it cannot be", async () => {
  const store = await shop();
  await traced(async () => (await import("@/lib/studio-route")).countStudio(store, null, 1));
  const before = await used(store);
  stripeCalls = 0;
  await loaded(store);
  assert.deepEqual({ units: (await used(store)) - before, read: stripeCalls > 0 }, { units: BUYER_LEDGER_UNITS, read: true });
  await pipeline([["DEL", ledgerKey(store)], ["SET", counterOf(store)!, String(allowanceFor(store, "studio") - (BUYER_LEDGER_UNITS - 1))]]);
  stripeCalls = 0;
  const { html } = await loaded(store);
  assert.equal(stripeCalls, 0);
  assert.ok(html.includes(`This needs ${BUYER_LEDGER_UNITS} of your studio requests, and only ${BUYER_LEDGER_UNITS - 1} are left.`), html);
});

test("rule 30: no reading of the buyers anywhere in the app goes uncounted", () => {
  // buyerLedger's count is optional (lib/segments.ts), so every caller outside it must pass one, and so must the
  // callers of what reads it for them (personAddresses, addressForPerson, createBroadcast). Every source file is read.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  for (const dir of ["app", "lib", "components"]) walk(dir);
  const uncounted = [/\bbuyerLedger\(\s*[\w.]+\s*\)/, /\bpersonAddresses\(\s*[\w.]+\s*,\s*[\w.]+\s*\)/, /\baddressForPerson\(\s*[\w.]+\s*,\s*[\w.]+\s*\)/];
  const found = files.filter((file) => uncounted.some((pattern) => pattern.test(readFileSync(file, "utf8").replace(/\s+/g, " "))));
  assert.deepEqual(found, []);
  // The deals table counts with the buyers page's own counter, and says the refusal's sentence.
  const table = readFileSync("components/deal-channels-table.tsx", "utf8");
  assert.ok(table.includes("buyerLedger(store, counting.count)") && table.includes("counting.said.message || NOT_COUNTED"));
});
