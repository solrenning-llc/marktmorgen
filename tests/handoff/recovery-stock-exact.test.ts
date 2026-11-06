/**
 * CX-123 rule 24: a limited product's stock that cannot be read is unknown,
 * never "no limit". The three single-product checkout reminders in
 * lib/checkout-recovery.ts (remindAbandoned, remindAsked, remindAssisted)
 * used to read it as `stockLeft(...).catch(() => null)`, and null is "not
 * limited", so the reminder went out, took one email from the store's
 * figure and invited a purchase the checkout then refuses (withStockHold).
 *
 * With only the stock read made unknown (a thrown read, an out-of-shape
 * reply, a missing reply), each of the three now answers "failed" (not sent
 * this round): no email, nothing taken from the store's email figure and
 * nothing written to Redis, so no sent, once-a-week or stop-link mark holds
 * back a later pass. The controls are as before: no limit and some left
 * send, none left skips.
 *
 * Turned from the proof tests/recovery-stock-unknown.proof.ts (branch
 * claude6/recovery-stock-proof, 0cd1e4ef). Uses the synthetic Resend literal
 * of tests/checkout-recovery-journey.test.ts (tests/resend-fixture-credentials.ts).
 * Synthetic data only.
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

const OWNER = "stockexact@example.com";
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

/** Every key the stand-in holds, with its value. */
const snapshot = (): Map<string, string> => new Map(redis.keys().map((key) => [key, String(redis.run(["DUMP", key]))]));
/** The keys a call wrote, made or removed between two snapshots: a reminder's sent, once-a-week or stop-link mark, its erasure note, the store's email figure. */
const changed = (before: Map<string, string>, after: Map<string, string>): string[] =>
  [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).sort();

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "stockexact", "Stock Exact", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestStockEx001", true);
  await setSubscription(OWNER, { customerId: "cus_StockEx001", subscriptionId: "sub_StockEx001", active: true, period: paidPeriod() });
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
      id: `cs_test_stockexact${String(n).padStart(6, "0")}`,
      object: "checkout.session",
      status: "expired",
      payment_status: "unpaid",
      created: now - 3700,
      expires_at: now - 100,
      consent: { promotions: "opt_in" },
      customer_details: { email: `buyer${n}@example.com` },
      metadata: { store: "stockexact", product },
    } as never;
  };
  const paths = {
    abandoned: async (product: string) => remindAbandoned(await load(), session(product)),
    asked: async (product: string) => {
      n += 1;
      return remindAsked(await load(), { productId: product, email: `buyer${n}@example.com`, askedAt: now - 600, key: `stockexactask${n}` });
    },
    assisted: async (product: string) => {
      const s = session(product) as unknown as { customer_details: { email: string } };
      return remindAssisted(await load(), s as never, { email: s.customer_details.email, why: "You asked for this reminder at checkout." });
    },
  } as const;

  const cases: { name: string; product: string; mode: Mode; want: "sent" | "skip" | "failed" }[] = [
    { name: "no limit", product: open, mode: "real", want: "sent" },
    { name: "some left (2)", product: some, mode: "real", want: "sent" },
    { name: "none left (0)", product: gone, mode: "real", want: "skip" },
    { name: "UNKNOWN: read throws", product: gone, mode: "throw", want: "failed" },
    { name: "UNKNOWN: reply out of shape", product: gone, mode: "shape", want: "failed" },
    { name: "UNKNOWN: reply missing", product: gone, mode: "missing", want: "failed" },
  ];

  let unknownCalls = 0, unknownSent = 0, unknownCounted = 0, unknownWrites = 0;
  for (const [pathName, run] of Object.entries(paths)) {
    part(`${pathName}: stock known and unknown`);
    for (const c of cases) {
      const mailsBefore = emails.length, usedBefore = await allowanceUsed(await load(), "email"), readsBefore = stockReads;
      const held = snapshot();
      mode = c.mode;
      const outcome = await run(c.product).catch((error: Error) => `threw: ${error.message}`);
      mode = "real";
      const after = snapshot();
      const mails = emails.length - mailsBefore;
      const counted = (await allowanceUsed(await load(), "email")) - usedBefore;
      is(`${pathName}, ${c.name}: outcome`, outcome, c.want);
      is(`${pathName}, ${c.name}: emails sent / taken from the store's figure`, [mails, counted], c.want === "sent" ? [1, 1] : [0, 0]);
      is(`${pathName}, ${c.name}: stock reads`, stockReads - readsBefore, c.product === open ? 0 : 1);
      if (c.mode !== "real") {
        unknownCalls += 1;
        unknownSent += mails;
        unknownCounted += counted;
        const written = changed(held, after);
        unknownWrites += written.length;
        is(`${pathName}, ${c.name}: no key written (no sent, once-a-week or stop-link mark)`, written, []);
      }
    }
  }
  part("Totals with the stock unknown");
  is("unknown stock: calls / emails / taken from the figure / keys written", [unknownCalls, unknownSent, unknownCounted, unknownWrites], [9, 0, 0, 0]);

  part("A later pass, with the stock readable again, still decides on the real count");
  is("abandoned, none left, read again: skip", await paths.abandoned(gone), "skip");
  is("asked, some left, read again: sent", await paths.asked(some), "sent");

  part("The checkout behind the link, with the same unknown read (unchanged)");
  for (const m of ["throw", "shape", "missing"] as Mode[]) {
    mode = m;
    let opened = 0;
    const product = (await readListing(await load(), gone))!;
    await withStockHold(await load(), product, async () => {
      opened += 1;
      return { id: "cs_test_never" };
    }).catch(() => null);
    mode = "real";
    is(`withStockHold, ${m}: no checkout is opened`, opened, 0);
  }
  const known = (await readListing(await load(), gone))!;
  is("withStockHold, none left: sold out", await withStockHold(await load(), known, async () => ({ id: "cs_test_never" })), { ok: false, reason: "soldout" });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
