/**
 * Proof only (rule-24 candidate, Claude 6, 6 November 2026): the three
 * single-product checkout reminders in lib/checkout-recovery.ts
 * (remindAbandoned, remindAsked, remindAssisted) read a limited product's
 * stock as `stockLeft(...).catch(() => null)` and skip only on `left === 0`.
 * `null` is "not limited", so a stock count that cannot be read lets the
 * reminder go. This file shows, with the real code and the Redis stand-in,
 * only the stock read made to fail (a thrown read, an out-of-shape reply,
 * a missing reply):
 *
 *   - whether the email is sent, what it says, and whether it takes one
 *     email from the store's figure (allowanceUsed "email");
 *   - the controls: no limit (sent), none left (skipped), some left (sent);
 *   - what the checkout behind the email's link does with the same unknown
 *     read (withStockHold, the guard app/api/store/checkout/route.ts uses).
 *
 * Uses the synthetic Resend literal of tests/checkout-recovery-journey.test.ts
 * (tests/resend-fixture-credentials.ts). Synthetic data only.
 * Not part of the CI run: node tests/g-proof-run.mjs
 * recovery-stock-unknown.proof.ts.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductExtras, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { remindAbandoned, remindAsked, remindAssisted } from "@/lib/checkout-recovery";
import { allowanceUsed } from "@/lib/store-allowance";
import { withStockHold } from "@/lib/stock";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_recovery_journey_only";
process.env.RESEND_API_KEY = "re_test_recovery_journey_only";

const OWNER = "stockproof@example.com";
type Mail = { to: string; subject: string; text: string };
const emails: Mail[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return answer({ id: `email_${emails.length}` });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${url.pathname}` } }, 404);
}) as typeof fetch;

// Only the stock read (one HGETALL of nl:stock:*) is touched; every other command is the stand-in's own.
type Command = (string | number)[];
type Mode = "real" | "throw" | "shape" | "missing";
let mode: Mode = "real";
let stockReads = 0;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  const isStock = batch.length === 1 && batch[0][0] === "HGETALL" && String(batch[0][1]).startsWith("nl:stock:");
  if (isStock) {
    stockReads += 1;
    if (mode === "throw") throw new Error("synthetic: stock read lost");
    if (mode === "shape") return [["odd-length"]];
    if (mode === "missing") return [];
  }
  return real(batch);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "stockproof", "Stock Proof", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestStock00001", true);
  await setSubscription(OWNER, { customerId: "cus_Stock00001", subscriptionId: "sub_Stock00001", active: true, period: paidPeriod() });
  await setRecovery(OWNER, { enabled: true, address: "1 Synthetic Way, Portland, OR 97201", asks: true });
  const add = async (title: string, stock: number | null) => {
    const made = await addProduct(OWNER, title, "", "30", null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    if (stock !== null) {
      const set = await setProductExtras(OWNER, made.product.id, { stock });
      if (!set.ok) throw new Error(`stock not set: ${JSON.stringify(set)}`);
    }
    return made.product.id;
  };
  const open = await add("Open Edition", null);
  const some = await add("Limited Print", 2);
  const gone = await add("Last Print", 1);
  const load = async () => (await storeForEmail(OWNER))!;
  const statsId = (await load()).statsId!;
  // The one unit of "Last Print" is paid for: none left.
  await real([["HSET", `nl:stock:${statsId}:${gone}`, "cs_test_paidunit0000001", JSON.stringify({ until: 0, paid: true })]]);

  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  const session = (product: string) => {
    n += 1;
    return {
      id: `cs_test_stockproof${String(n).padStart(6, "0")}`,
      object: "checkout.session",
      status: "expired",
      payment_status: "unpaid",
      created: now - 3700,
      expires_at: now - 100,
      consent: { promotions: "opt_in" },
      customer_details: { email: `buyer${n}@example.com` },
      metadata: { store: "stockproof", product },
    } as never;
  };
  const paths = {
    abandoned: async (product: string) => remindAbandoned(await load(), session(product)),
    asked: async (product: string) => {
      n += 1;
      return remindAsked(await load(), { productId: product, email: `buyer${n}@example.com`, askedAt: now - 600, key: `stockproofask${n}` });
    },
    assisted: async (product: string) => {
      const s = session(product) as unknown as { customer_details: { email: string } };
      return remindAssisted(await load(), s as never, { email: s.customer_details.email, why: "You asked for this reminder at checkout." });
    },
  } as const;

  const cases: { name: string; product: string; mode: Mode; want: "sent" | "skip" }[] = [
    { name: "no limit", product: open, mode: "real", want: "sent" },
    { name: "some left (2)", product: some, mode: "real", want: "sent" },
    { name: "none left (0)", product: gone, mode: "real", want: "skip" },
    { name: "UNKNOWN: read throws", product: gone, mode: "throw", want: "sent" },
    { name: "UNKNOWN: reply out of shape", product: gone, mode: "shape", want: "sent" },
    { name: "UNKNOWN: reply missing", product: gone, mode: "missing", want: "sent" },
  ];

  const rows: string[] = [];
  let unknownSent = 0, unknownCounted = 0, unknownCalls = 0;
  for (const [pathName, run] of Object.entries(paths)) {
    part(`${pathName}: stock known and unknown`);
    for (const c of cases) {
      mode = c.mode;
      const mailsBefore = emails.length, usedBefore = await allowanceUsed(await load(), "email"), readsBefore = stockReads;
      const outcome = await run(c.product);
      mode = "real";
      const mails = emails.length - mailsBefore;
      const counted = (await allowanceUsed(await load(), "email")) - usedBefore;
      const reads = stockReads - readsBefore;
      const mail = mails ? emails.at(-1)! : null;
      const invites = mail ? mail.text.includes(`/p/${c.product}`) && /it is here:|asked about/i.test(mail.text) : false;
      rows.push(`${pathName.padEnd(9)} | ${c.name.padEnd(27)} | ${String(outcome).padEnd(5)} | mails ${mails} | counted ${counted} | stock reads ${reads}${mail ? ` | "${mail.subject}"` : ""}`);
      is(`${pathName}, ${c.name}: outcome`, outcome, c.want);
      is(`${pathName}, ${c.name}: emails sent / taken from the store's figure`, [mails, counted], c.want === "sent" ? [1, 1] : [0, 0]);
      if (c.mode !== "real") {
        unknownCalls += 1;
        if (mails) unknownSent += 1;
        unknownCounted += counted;
        is(`${pathName}, ${c.name}: the stock read was the one made unknown`, reads, 1);
        is(`${pathName}, ${c.name}: the email leads back to the sold-out product's page and its price`, [invites, mail?.text.includes("$30")], [true, true]);
      }
    }
  }

  part("The checkout behind the link, with the same unknown read");
  const outcomes: string[] = [];
  for (const m of ["throw", "shape", "missing"] as Mode[]) {
    mode = m;
    let opened = 0;
    const product = (await readListing(await load(), gone))!;
    const result = await withStockHold(await load(), product, async () => {
      opened += 1;
      return { id: "cs_test_never" };
    }).then((r) => JSON.stringify(r), (e: Error) => `threw: ${e.message}`);
    mode = "real";
    outcomes.push(`${m}: ${result}, opened ${opened}`);
    is(`withStockHold, ${m}: no checkout is opened`, opened, 0);
  }
  mode = "real";
  const known = (await readListing(await load(), gone))!;
  is("withStockHold, none left: sold out", await withStockHold(await load(), known, async () => ({ id: "cs_test_never" })), { ok: false, reason: "soldout" });

  console.log("\n--- table ---\n" + rows.join("\n"));
  console.log("\n--- checkout guard ---\n" + outcomes.join("\n"));
  console.log(`\nunknown stock: ${unknownSent} of ${unknownCalls} calls sent an email; ${unknownCounted} taken from the store's email figure.`);
  console.log("\n--- one email sent with the stock unknown ---\n" + emails.find((e) => e.text.includes(`/p/${gone}`))?.text);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
