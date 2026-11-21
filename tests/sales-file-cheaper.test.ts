/**
 * The sales file's real cost (app/api/store/export?what=sales, lib/stats.ts
 * salesCsv), lowered without a migration and without leaving out a row or a
 * column (Claude 4's option D measurements, 7 November 2026):
 *
 *   - the products the file names are read before its rows, in MGETs of up to
 *     LISTING_MGET_KEYS records (sized by the bytes an answer may carry, Codex S
 *     and Codex Z on #3101; tests/sales-file-batch-bytes.test.ts), a few side by
 *     side: at most ceil(N/LISTING_MGET_KEYS) + 2 product reads for N products,
 *     never one GET for each product (up to 2,002);
 *   - each cell holds a bounded number of UTF-8 bytes in the file, a cut marked
 *     with a visible "…": a row is at most 2,435 bytes, every row is still there,
 *     and an ordinary file is byte for byte what it was;
 *   - a product record that does not read is said (the route's "did not answer"),
 *     never written as a missing product (CX-123 rule 24); one Redis confirms is
 *     not there still falls back to the title the sale carried, as before.
 */
import { addOption, addProduct, claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { type Item, KIND, LISTING_MGET_KEYS, listingFinder } from "@/lib/catalog";
import { csvRow, readPaidSales, salesCsv } from "@/lib/stats";
import { bumpsFromMeta } from "@/lib/bundle-rules";
import { plainAmount } from "@/lib/money";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_sales_file_cheaper_only";

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

const HANDLE = "cheaperfile";
const CREATED = 1_791_417_600;
const checkout = (n: number, meta: Record<string, string>, more: Row = {}): Row => ({
  id: `cs_test_${String(n).padStart(6, "0")}`,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  created: CREATED - n,
  amount_total: 4900,
  currency: "usd",
  total_details: { amount_discount: 0, amount_tax: 0 },
  customer_details: { email: `buyer${n}@example.com`, name: `Buyer ${n}`, address: { country: "US" } },
  metadata: { store: HANDLE, ...meta },
  ...more,
});

/** The sales file exactly as lib/stats.ts made it before this change: one product read after another. */
async function filedBefore(store: Store): Promise<string> {
  const { sales } = await readPaidSales(store, 0, 50);
  const find = listingFinder(store);
  const title = async (id: string, fallback: unknown) => (await find(id))?.title ?? (typeof fallback === "string" ? fallback : "");
  const lines = [csvRow(["paid_at_utc", "stripe_id", "product_id", "product", "price_option", "order_bump", "kind", "amount", "discount", "tax", "currency", "buyer_email", "buyer_name", "buyer_country", "paid_with"])];
  for (const sale of sales) {
    const row = sale.row;
    const meta = (row.metadata ?? {}) as Record<string, string>;
    const details = (row.customer_details ?? {}) as { email?: unknown; name?: unknown; address?: { country?: unknown } | null };
    const totals = (row.total_details ?? {}) as { amount_discount?: unknown; amount_tax?: unknown };
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    const cents = (v: unknown) => (typeof v === "number" ? v : 0);
    const product = await find(sale.product);
    const option = product?.options.find((o) => o.id === meta.option)?.label ?? meta.option ?? "";
    const kind = sale.upsell ? "upsell" : meta.kind === "tip" ? "support" : meta.kind === "call" ? "call" : meta.kind === "plan" ? "payment_plan" : row.mode === "subscription" ? "membership" : "one_time";
    lines.push(csvRow([
      new Date(sale.created).toISOString().replace(/\.\d{3}Z$/, "Z"),
      text(row.id),
      sale.product,
      await title(sale.product, meta.title),
      option,
      (await Promise.all(bumpsFromMeta(meta).map((added) => title(added.id, "")))).filter(Boolean).join(" + "),
      kind,
      plainAmount(sale.cents, sale.currency),
      plainAmount(cents(totals.amount_discount), sale.currency),
      plainAmount(cents(totals.amount_tax), sale.currency),
      sale.currency.toUpperCase(),
      text(details.email) || text(row.customer_email) || text(row.receipt_email),
      text(details.name),
      text(details.address?.country),
      meta.paid_with === "paypal" ? "paypal" : "stripe",
    ]));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** The cells of one CSV line made by csvRow (every cell quoted, quotes doubled). */
function cellsOf(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '"') throw new Error(`unquoted cell at ${i}`);
    let cell = "";
    i += 1;
    for (;;) {
      if (line[i] === '"' && line[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (line[i] === '"') { i += 1; break; }
      cell += line[i];
      i += 1;
    }
    out.push(cell);
    if (line[i] === ",") i += 1;
  }
  return out;
}

const listingKeyRe = /^nl:catalog:[^:]+:l:/;
/** Counts the database trips that read a product record while `work` runs. */
async function productTrips<T>(work: () => Promise<T>): Promise<{ result: T; trips: number; commands: number }> {
  const original = redis.pipeline;
  let trips = 0;
  let commands = 0;
  redis.pipeline = (async (cmds: (string | number)[][]) => {
    const reads = cmds.filter((cmd) => cmd.slice(1).some((arg) => typeof arg === "string" && listingKeyRe.test(arg)));
    if (reads.length) { trips += 1; commands += reads.length; }
    return original.call(redis, cmds);
  }) as typeof redis.pipeline;
  try {
    return { result: await work(), trips, commands };
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("cheaper@example.com", HANDLE, "Cheaper File Store", "");
  await ensureStatsId("cheaper@example.com");
  await setStripeAccount("cheaper@example.com", "acct_fixture3101", true);
  const first = await addProduct("cheaper@example.com", "Sourdough \"Starter\" Guide", "", "49", null);
  if (!first.ok) throw new Error("no product");
  const optioned = await addOption("cheaper@example.com", first.product.id, "Signed copy — €", "59");
  if (!optioned.ok) throw new Error(`no option: ${optioned.reason}`);
  const second = await addProduct("cheaper@example.com", "=Formula Bread", "", "19", null);
  if (!second.ok) throw new Error("no second product");
  const base = (await storeForEmail("cheaper@example.com"))!;
  const catalogId = base.catalog.id!;
  const [templateRaw] = await redis.pipeline([["GET", `nl:catalog:${catalogId}:l:${first.product.id}`]]);
  const template = JSON.parse(String(templateRaw)) as Record<string, unknown>;
  const optionId = (template.options as { id: string }[])[0].id;

  part("An ordinary file is byte for byte what it was");
  {
    const absent = "pGone0000001"; // in the catalog's index, its record confirmed not there
    const store: Store = { ...base, catalog: { ...base.catalog, items: [...base.catalog.items, { id: absent, kind: KIND.paid, options: [] }] } };
    sessions = [
      checkout(1, { product: first.product.id, option: optionId, title: "Old title" }, { customer_details: { email: "ana@example.com", name: "Ana \"Nana\" Souza-Øvergård 😀", address: { country: "BR" } } }),
      checkout(2, { product: second.product.id, bump: first.product.id, bump2: absent, title: "=Formula Bread" }, { total_details: { amount_discount: 500, amount_tax: 120 } }),
      checkout(3, { product: absent, title: "Kept title of a deleted product", option: "Large" }),
      checkout(4, { product: "not-in-this-store", kind: "tip" }, { mode: "payment", customer_details: { email: "", name: "+Plus", address: null }, customer_email: "fallback@example.com" }),
      checkout(5, { product: first.product.id, kind: "plan" }, { mode: "subscription", currency: "eur", amount_total: 1999 }),
    ];
    const before = await filedBefore(store);
    const now = await salesCsv(store, 0);
    is("the same bytes as before", now.csv, before);
    is("every sale a row, none partial", [now.rows, now.partial, now.csv.split("\r\n").length - 2], [5, false, 5]);
    is("a product confirmed gone keeps the title its sale carried", cellsOf(now.csv.split("\r\n")[3])[3], "Kept title of a deleted product");
  }

  part("Products are read in batches, not one after another");
  {
    const N = 1_203;
    const ids = Array.from({ length: N }, (_, n) => `p${String(n).padStart(5, "0")}`);
    const writes = ids.map((id, n) => ["SET", `nl:catalog:${catalogId}:l:${id}`, JSON.stringify({ ...template, id, title: `Product ${n}`, options: n % 7 === 0 ? template.options : [] })]);
    for (let i = 0; i < writes.length; i += 400) await redis.pipeline(writes.slice(i, i + 400) as (string | number)[][]);
    const items: Item[] = ids.map((id) => ({ id, kind: KIND.paid, options: [] }));
    const head = base.catalog.head.filter((l) => l.id === first.product.id);
    const store: Store = { ...base, catalog: { id: catalogId, items: [...base.catalog.items, ...items], head, inline: null } };
    sessions = Array.from({ length: Math.ceil(N / 4) }, (_, r) => {
      const [a, b, c, d] = [ids[4 * r], ids[4 * r + 1], ids[4 * r + 2], ids[4 * r + 3]];
      return checkout(10 + r, { product: a, ...(b ? { bump: b } : {}), ...(c ? { bump2: c } : {}), ...(d ? { bump3: d } : {}), title: "Stale" });
    });
    const { result, trips, commands } = await productTrips(() => salesCsv(store, 0));
    const bound = Math.ceil(N / LISTING_MGET_KEYS) + 2;
    is(`at most ceil(N/LISTING_MGET_KEYS) + 2 = ${bound} trips for ${N} products`, trips <= bound ? "within" : `${trips} trips`, "within");
    is("and a command for each batch, never one for each product", commands <= bound ? "within" : `${commands} commands`, "within");
    const lines = result.csv.split("\r\n");
    is("every sale is still a row", [result.rows, lines.length - 2], [sessions.length, sessions.length]);
    const firstRow = cellsOf(lines[1]);
    is("each product's own title, and its extras' titles", [firstRow[3], firstRow[5]], ["Product 0", "Product 1 + Product 2 + Product 3"]);
    is("byte for byte what it was", result.csv, await filedBefore(store));
  }

  part("Each cell is bounded in the file, a cut marked, no row left out");
  {
    const long = (unit: string, n: number) => unit.repeat(n);
    sessions = [
      checkout(1, { product: "p".repeat(64) + "x".repeat(400), title: long("\u{1F600}", 900), option: long('"', 700) }, {
        id: `cs_test_${"z".repeat(900)}`,
        customer_details: { email: `${long("a", 900)}@example.com`, name: `=${long("Ø\"", 1500)}`, address: { country: "ABCDEFG" } },
      }),
      checkout(2, { product: first.product.id, option: optionId }, { customer_details: { email: "plain@example.com", name: long("名", 400), address: { country: "JP" } } }),
      checkout(3, { product: second.product.id }),
    ];
    const made = await salesCsv(base, 0);
    const lines = made.csv.split("\r\n");
    is("every sale is still a row, every column still there", [made.rows, lines.length - 2, ...lines.slice(0, 4).map((l) => cellsOf(l).length)], [3, 3, 15, 15, 15, 15]);
    const widest = Math.max(...lines.slice(1, -1).map((l) => Buffer.byteLength(`${l}\r\n`, "utf8")));
    is("no row is more than 2,435 bytes", widest <= 2_435 ? "within" : `${widest} bytes`, "within");
    const cut = cellsOf(lines[1]);
    const weigh = (s: string) => Buffer.byteLength(s.replace(/"/g, '""'), "utf8");
    is("a long buyer name is cut at 600 bytes, with a visible mark", [cut[12].endsWith("…"), weigh(cut[12].replace(/^'/, "")) <= 600, cut[12].startsWith("'=Ø\"")], [true, true, true]);
    is("so are an email and an id no real one could be", [cut[11].endsWith("…"), weigh(cut[11]) <= 254, cut[1].endsWith("…"), weigh(cut[1]) <= 255], [true, true, true, true]);
    is("a buyer name of 400 characters in another alphabet is cut too, with the mark", cellsOf(lines[2])[12].endsWith("…"), true);
    is("a catalog title and option label are never cut", [cellsOf(lines[2])[3], cellsOf(lines[2])[4], cellsOf(lines[3])[3]], ["Sourdough \"Starter\" Guide", "Signed copy — €", "'=Formula Bread"]);
  }

  part("A product record that does not read is said, never a missing product (rule 24)");
  {
    sessions = [checkout(1, { product: first.product.id, bump: second.product.id, title: "Should not be used" })];
    const noHead: Store = { ...base, catalog: { ...base.catalog, head: [] } };
    // Without the catalog's names (lib/catalog.ts namesKey), as a store saved before them: the records are read.
    await redis.pipeline([["DEL", `nl:catalog:${catalogId}:n`]]);
    for (const [label, reply] of [
      ["no reply for the read", () => []],
      ["a reply of another type", (cmds: (string | number)[][]) => cmds.map(() => 42)],
      ["a list cut short", (cmds: (string | number)[][]) => cmds.map((cmd) => (cmd[0] === "MGET" ? [] : null))],
      ["a record that is not a listing", (cmds: (string | number)[][]) => cmds.map((cmd) => (cmd[0] === "MGET" ? cmd.slice(1).map(() => "{not json") : "{not json"))],
    ] as [string, (cmds: (string | number)[][]) => unknown[]][]) {
      const original = redis.pipeline;
      redis.pipeline = (async (cmds: (string | number)[][]) =>
        cmds.some((cmd) => cmd.slice(1).some((arg) => typeof arg === "string" && listingKeyRe.test(arg))) ? reply(cmds) : original.call(redis, cmds)) as typeof redis.pipeline;
      let outcome = "";
      try {
        const made = await salesCsv(noHead, 0);
        outcome = `written: ${cellsOf(made.csv.split("\r\n")[1])[3] || "(blank)"}`;
      } catch {
        outcome = "said";
      } finally {
        redis.pipeline = original;
      }
      is(`${label}: the file is not made`, outcome, "said");
    }
    const made = await salesCsv(noHead, 0);
    is("a healthy read still writes the product's title", cellsOf(made.csv.split("\r\n")[1]).slice(3, 6), ["Sourdough \"Starter\" Guide", "", "'=Formula Bread"]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
