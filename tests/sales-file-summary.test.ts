/**
 * The sales file's PayPal sales and product names read from short copies kept
 * for it (Claude 4's option D, candidates 1b and 1c, 7 November 2026), on the
 * real code path (lib/paypal-sales.ts captureOrder and settle, lib/stats.ts
 * salesCsv, lib/catalog.ts productWrites and productDrops):
 *
 *   - each PayPal sale paid writes a short line beside its record, with only
 *     what the file shows, at most PAYPAL_SUMMARY_BYTES; the file reads those
 *     lines, never the whole record, so a heavy record costs a line's bytes;
 *   - a sale without its line, or whose line does not read, is read whole and
 *     counted, never left out and never a blank row; a record confirmed gone
 *     is left out as before; one that does not read is said (CX-123 rule 24);
 *   - every product's title and its options' labels are kept in one hash of
 *     names, written and taken away with the product: the file reads those,
 *     never the product records, and reads the record when a name is missing
 *     or does not read;
 *   - an ordinary file is byte for byte what it was;
 *   - the line has the buyer's address, so a closed store's deletion takes it
 *     with the record.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addOption, addProduct, claimHandle, editProduct, ensureStatsId, removeProduct, setPayPalSeller, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { listingFinder, readListing } from "@/lib/catalog";
import { captureOrder, openOrder, paypalOrderKeys } from "@/lib/paypal-sales";
import { csvRow, readPaidSales, salesCsv } from "@/lib/stats";
import { bumpsFromMeta } from "@/lib/bundle-rules";
import { plainAmount } from "@/lib/money";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
process.env.RESEND_API_KEY = "re_test_sales_file_summary";
delete process.env.PAYPAL_ENV;

let made = 0;
const orderId = (n: number) => `5O190127TN3647${String(n).padStart(3, "0")}`;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
  if (url.hostname !== "api-m.paypal.com") return json({ object: "list", data: [], has_more: false });
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture) {
    return json({
      id: capture,
      status: "COMPLETED",
      payer: { email_address: `buyer${capture.slice(-3)}@example.com` },
      purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH90${capture.slice(-3)}`, status: "COMPLETED", amount: { currency_code: "USD", value: "49.00" } }] } }],
    }, 201);
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

/** The sales file as lib/stats.ts made it before the short copies: every record read whole, every product read. */
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

type Watch = { bytes: number; commands: number; trips: number };
/** What the file reads from Redis under keys matching `keys` while `work` runs: reply bytes, commands and trips. */
async function reading<T>(keys: RegExp, work: () => Promise<T>): Promise<{ result: T } & Watch> {
  const original = redis.pipeline;
  const seen: Watch = { bytes: 0, commands: 0, trips: 0 };
  redis.pipeline = (async (cmds: (string | number)[][]) => {
    const replies = await original.call(redis, cmds);
    const touched = cmds.map((cmd, i) => [cmd, replies[i]] as const).filter(([cmd]) => cmd.slice(1).some((arg) => typeof arg === "string" && keys.test(arg)));
    if (touched.length) {
      seen.trips += 1;
      seen.commands += touched.length;
      for (const [, reply] of touched) seen.bytes += Buffer.byteLength(JSON.stringify(reply ?? null), "utf8");
    }
    return replies;
  }) as typeof redis.pipeline;
  try {
    return { result: await work(), ...seen };
  } finally {
    redis.pipeline = original;
  }
}

/** Replaces the replies to the commands that touch `keys` while `work` runs. */
async function answering<T>(keys: RegExp, reply: (cmds: (string | number)[][], real: unknown[]) => unknown[], work: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (cmds: (string | number)[][]) => {
    const real = await original.call(redis, cmds);
    return cmds.some((cmd) => cmd.slice(1).some((arg) => typeof arg === "string" && keys.test(arg))) ? reply(cmds, real) : real;
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const said = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return "made";
  } catch {
    return "said";
  }
};

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "summary@example.com";
  await claimHandle(OWNER, "summaryshop", "Summary Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Summary0001", subscriptionId: "sub_Summary0001", active: true, period: paidPeriod() });
  const added = await addProduct(OWNER, "Sourdough \"Starter\" Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(OWNER, added.product.id, "https://example.com/guide");
  await setPayPalSeller(OWNER, SELLER);
  const base = (await storeForEmail(OWNER))!;
  const statsId = base.statsId!;
  const catalogId = base.catalog.id!;
  const product = (await readListing(base, added.product.id))!;

  // Each order carries the twenty fields of what its visit carried at their longest (lib/paypal-sales.ts cleanMeta): its record is heavy.
  const heavyMeta = (n: number) => Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`utm_${String.fromCharCode(97 + i)}`, `${n}`.padEnd(200, "x")]));
  const orders: string[] = [];
  for (let n = 0; n < 30; n += 1) {
    const opened = await openOrder(base, product, "https://marktmorgen.com", { meta: { ...heavyMeta(n), title: `Kept title ${n}` }, digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
    const paid = await captureOrder(base, opened.order);
    if (!paid.ok) throw new Error(`not paid: ${paid.reason}`);
    orders.push(opened.order);
  }
  const recordBytes = Buffer.byteLength(String((await redis.pipeline([["GET", `nl:ppsell:paid:${orders[0]}`]]))[0]), "utf8");
  const noHead: Store = { ...base, catalog: { ...base.catalog, head: [] } };

  part("Each PayPal sale paid writes its short line, with what the file shows");
  {
    const [line] = await redis.pipeline([["GET", `nl:ppsell:sum:${orders[0]}`]]);
    is("a line is written beside the record", typeof line, "string");
    const bytes = Buffer.byteLength(String(line), "utf8");
    is(`at most 1,044 bytes, though the record weighs ${recordBytes}`, bytes <= 1_044 && recordBytes > 4_000 ? "short" : `${bytes} of ${recordBytes}`, "short");
    const [lineTtl, recordTtl] = await redis.pipeline([["TTL", `nl:ppsell:sum:${orders[0]}`], ["TTL", `nl:ppsell:paid:${orders[0]}`]]);
    is("kept no longer than the record", [Number(lineTtl) > 0, Number(lineTtl) <= Number(recordTtl)], [true, true]);
  }

  part("The file reads the short lines, never the whole records");
  {
    const before = await filedBefore(noHead);
    const { result, bytes } = await reading(/^nl:ppsell:(paid|sum):/, () => salesCsv(noHead, 0));
    is("byte for byte what it was", result.csv, before);
    is("every sale a row", [result.rows, result.csv.split("\r\n").length - 2], [30, 30]);
    is(`at most 30 lines' bytes (${30 * 1_044}), not 30 records (${30 * recordBytes})`, bytes <= 30 * 1_044 + 200 ? "lines" : `${bytes} bytes`, "lines");
    is("no sale read whole", (result as { wholeRecords?: number }).wholeRecords, 0);
  }

  part("A sale without its line, or whose line does not read, is read whole and counted");
  {
    await redis.pipeline([["DEL", `nl:ppsell:sum:${orders[3]}`], ["SET", `nl:ppsell:sum:${orders[7]}`, "{not a line"], ["SET", `nl:ppsell:sum:${orders[9]}`, JSON.stringify({ o: "OTHERORDER0001" })]]);
    const before = await filedBefore(noHead);
    const made = await salesCsv(noHead, 0);
    is("every sale still a row, the same bytes", [made.rows, made.csv === before], [30, true]);
    is("the three read whole, and counted", (made as { wholeRecords?: number }).wholeRecords, 3);
    const row = made.csv.split("\r\n").find((l) => l.includes(`paypal:${orders[3]}`)) ?? "";
    is("the row read whole has its address and amount", [row.includes(`buyer${orders[3].slice(-3)}@example.com`), row.includes('"49.00"')], [true, true]);
  }

  part("A record confirmed gone is left out, as before; one that does not read is said (rule 24)");
  {
    await redis.pipeline([["DEL", `nl:ppsell:sum:${orders[4]}`, `nl:ppsell:paid:${orders[4]}`]]);
    const made = await salesCsv(noHead, 0);
    is("a sale whose line and record are both gone is not a row", [made.rows, made.csv.includes(orders[4])], [29, false]);
    await redis.pipeline([["DEL", `nl:ppsell:sum:${orders[5]}`], ["SET", `nl:ppsell:paid:${orders[5]}`, "{not json"]]);
    is("a record that is not JSON, its line missing: the file is not made", await said(() => salesCsv(noHead, 0)), "said");
    await redis.pipeline([["SET", `nl:ppsell:paid:${orders[5]}`, JSON.stringify({ store: "another-store", order: orders[5] })]]);
    is("a record of another shape: the file is not made", await said(() => salesCsv(noHead, 0)), "said");
    await redis.pipeline([["DEL", `nl:ppsell:paid:${orders[5]}`]]);
    for (const [label, reply] of [
      ["no reply for the lines", () => []],
      ["the lines' reply of another type", (cmds: (string | number)[][]) => cmds.map(() => 42)],
      ["the lines' list cut short", (cmds: (string | number)[][]) => cmds.map((cmd) => (cmd[0] === "MGET" ? [] : null))],
    ] as [string, (cmds: (string | number)[][]) => unknown[]][]) {
      is(`${label}: the file is not made`, await answering(/^nl:ppsell:sum:/, reply, () => said(() => salesCsv(noHead, 0))), "said");
    }
    is("the list of sales in another shape: the file is not made", await answering(/^nl:ppsell:sales:/, (cmds) => cmds.map(() => "not a list"), () => said(() => salesCsv(noHead, 0))), "said");
    is("a healthy read still makes it", await said(() => salesCsv(noHead, 0)), "made");
  }

  part("A closed store's deletion takes the line with the record");
  is("the line is among an order's keys", paypalOrderKeys(orders[0]).includes(`nl:ppsell:sum:${orders[0]}`), true);

  part("Product names are kept in one hash, with the product");
  {
    const namesKey = `nl:catalog:${catalogId}:n`;
    const optioned = await addOption(OWNER, added.product.id, "Signed copy — €", "59");
    if (!optioned.ok) throw new Error("no option");
    const [entry] = await redis.pipeline([["HGET", namesKey, added.product.id]]);
    is("the title and the option's label, written with the product", typeof entry === "string" && entry.includes("Sourdough") && entry.includes("Signed copy — €"), true);
    const edited = await editProduct(OWNER, added.product.id, "Sourdough Guide, Second Edition", "", "49");
    if (!edited.ok) throw new Error("not edited");
    const [renamed] = await redis.pipeline([["HGET", namesKey, added.product.id]]);
    is("a new title is written with it", typeof renamed === "string" && renamed.includes("Second Edition"), true);
    const extra = await addProduct(OWNER, "To be removed", "", "9", null);
    if (!extra.ok) throw new Error("no extra");
    const removed = await removeProduct(OWNER, extra.product.id);
    if (!removed.ok) throw new Error("not removed");
    const [gone] = await redis.pipeline([["HGET", namesKey, extra.product.id]]);
    is("and taken away with it", gone, null);
  }

  part("The file reads the names, never the product records");
  {
    const store = { ...(await storeForEmail(OWNER))!, catalog: { ...(await storeForEmail(OWNER))!.catalog, head: [] } } as Store;
    const listingKeys = new RegExp(`^nl:catalog:${catalogId}:l:`);
    const { result, commands } = await reading(listingKeys, () => salesCsv(store, 0));
    is("no product record read", commands, 0);
    is("byte for byte what it was", result.csv, await filedBefore(store));
    is("its title from the names", result.csv.split("\r\n")[1].includes("Second Edition"), true);
    await redis.pipeline([["HDEL", `nl:catalog:${catalogId}:n`, added.product.id]]);
    const missing = await reading(listingKeys, () => salesCsv(store, 0));
    is("a name missing: the record is read, the same bytes", [missing.commands > 0, missing.result.csv === result.csv], [true, true]);
    await redis.pipeline([["HSET", `nl:catalog:${catalogId}:n`, added.product.id, "[not names"]]);
    const unreadable = await reading(listingKeys, () => salesCsv(store, 0));
    is("a name that does not read: the record is read, the same bytes", [unreadable.commands > 0, unreadable.result.csv === result.csv], [true, true]);
    is("the names' reply of another type: the file is not made", await answering(new RegExp(`^nl:catalog:${catalogId}:n$`), (cmds) => cmds.map(() => 42), () => said(() => salesCsv(store, 0))), "said");
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
