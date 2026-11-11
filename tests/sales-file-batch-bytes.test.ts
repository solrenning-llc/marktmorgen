/**
 * Codex S's and Codex Z's financial reviews of #3101 (MEDIUM): the sales file's product reads are bounded by the bytes
 * an answer can carry, not only by a count of keys. Before, one MGET named up to 500 records; each record may weigh up
 * to MAX_PRODUCT_BYTES (a call with its whole schedule is about 29 KB), so 500 of them came back as one answer of
 * about 15 MB, past Upstash's documented 10 MB a request (max_request_size_exceeded, read 7 November 2026), and the
 * file failed every time. Now an MGET names at most LISTING_MGET_KEYS records, sized so that even every record at
 * MAX_PRODUCT_BYTES with every byte escaped in the JSON answer (\uXXXX, six bytes) stays under LISTING_MGET_ANSWER_BYTES,
 * and at most LISTING_MGET_PARALLEL of them are in flight at once. Synthetic data only; the 10 MB ceiling is declared
 * here, as a provider that refuses a larger answer.
 */
import { claimHandle, ensureStatsId, setStripeAccount, addProduct, storeForEmail, type Store } from "@/lib/store";
import * as catalog from "@/lib/catalog";
import { KIND, MAX_PRODUCT_BYTES, type Item } from "@/lib/catalog";
import { salesCsv } from "@/lib/stats";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_sales_file_batch_only";

const HANDLE = "batchbytes";
const PROVIDER_ANSWER_CEILING = 10_000_000;
type Row = Record<string, unknown>;
let sessions: Row[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname !== "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  const after = url.searchParams.get("starting_after");
  const from = after ? sessions.findIndex((row) => row.id === after) + 1 : 0;
  const data = sessions.slice(from, from + 100);
  return new Response(JSON.stringify({ object: "list", data, has_more: from + 100 < sessions.length }), { status: 200 });
}) as typeof fetch;

const checkout = (n: number, product: string): Row => ({
  id: `cs_test_${String(n).padStart(6, "0")}`,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  created: 1_791_417_600 - n,
  amount_total: 4900,
  currency: "usd",
  total_details: { amount_discount: 0, amount_tax: 0 },
  customer_details: { email: `buyer${n}@example.com`, name: `Buyer ${n}`, address: { country: "US" } },
  metadata: { store: HANDLE, product, title: "Stale" },
});

const listingKeyRe = /^nl:catalog:[^:]+:l:/;

async function main(): Promise<void> {
  const exported = catalog as unknown as Record<string, unknown>;
  const keys = Number(exported.LISTING_MGET_KEYS);
  const answerBytes = Number(exported.LISTING_MGET_ANSWER_BYTES);
  const parallel = Number(exported.LISTING_MGET_PARALLEL);
  const worstRecord = 6 * MAX_PRODUCT_BYTES + 3;

  part("The bound holds at the worst, by construction");
  is("an answer budget is named, under the provider's 10 MB", Number.isSafeInteger(answerBytes) && answerBytes > 0 && answerBytes <= PROVIDER_ANSWER_CEILING, true);
  is("an MGET's worst answer (every record at its bound, every byte escaped) fits that budget", Number.isSafeInteger(keys) && keys >= 1 && keys * worstRecord <= answerBytes, true);
  is("and what is in flight at once stays under 64 MB", Number.isSafeInteger(parallel) && parallel >= 1 && parallel * keys * worstRecord <= 64_000_000, true);

  redis.clear();
  await claimHandle("batch@example.com", HANDLE, "Batch Bytes Store", "");
  await ensureStatsId("batch@example.com");
  await setStripeAccount("batch@example.com", "acct_fixture3101b", true);
  const first = await addProduct("batch@example.com", "A call with its whole schedule", "", "49", null);
  if (!first.ok) throw new Error("no product");
  const base = (await storeForEmail("batch@example.com"))!;
  const catalogId = base.catalog.id!;
  const [templateRaw] = await redis.pipeline([["GET", `nl:catalog:${catalogId}:l:${first.product.id}`]]);
  const template = JSON.parse(String(templateRaw)) as Record<string, unknown>;

  part("500 records of about 29 KB each: the file is made, every answer under the provider's ceiling");
  const N = 500;
  const ids = Array.from({ length: N }, (_, n) => `q${String(n).padStart(5, "0")}`);
  const pad = "w".repeat(29_000);
  const writes = ids.map((id, n) => ["SET", `nl:catalog:${catalogId}:l:${id}`, JSON.stringify({ ...template, id, title: `Product ${n}`, schedule: pad })]);
  for (let i = 0; i < writes.length; i += 100) await redis.pipeline(writes.slice(i, i + 100) as (string | number)[][]);
  const items: Item[] = ids.map((id) => ({ id, kind: KIND.paid, options: [] }));
  const store: Store = { ...base, catalog: { id: catalogId, items: [...base.catalog.items, ...items], head: [], inline: null } };
  sessions = ids.map((id, n) => checkout(n + 1, id));

  const original = redis.pipeline;
  let largest = 0;
  let inFlight = 0;
  let most = 0;
  redis.pipeline = (async (cmds: (string | number)[][]) => {
    const reads = cmds.some((cmd) => cmd.slice(1).some((arg) => typeof arg === "string" && listingKeyRe.test(arg)));
    if (!reads) return original.call(redis, cmds);
    inFlight += 1;
    most = Math.max(most, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const answer = await original.call(redis, cmds);
      const bytes = Buffer.byteLength(JSON.stringify(answer), "utf8");
      largest = Math.max(largest, bytes);
      if (bytes > PROVIDER_ANSWER_CEILING) throw new Error("max_request_size_exceeded (synthetic provider)");
      return answer;
    } finally {
      inFlight -= 1;
    }
  }) as typeof redis.pipeline;
  let made: Awaited<ReturnType<typeof salesCsv>> | "failed";
  try {
    made = await salesCsv(store, 0);
  } catch {
    made = "failed";
  } finally {
    redis.pipeline = original;
  }
  is("the file is made", made === "failed" ? "failed" : "made", "made");
  is("with every sale a row and each product's own title", made === "failed" ? null : [made.rows, made.csv.includes("\"Product 499\""), made.csv.includes("\"Stale\"")], [N, true, false]);
  is("no answer passed the provider's ceiling", largest <= PROVIDER_ANSWER_CEILING ? "under" : `${largest} bytes`, "under");
  is("no more MGETs in flight at once than the bound", most <= parallel ? "within" : `${most} at once`, "within");
  done();
}

void main();
