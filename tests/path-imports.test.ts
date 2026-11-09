/**
 * Queue item 10 [D7]: "an import never creates a confirmed lead nor a sale",
 * while imported products may still meet the Path facts. Exercised through the
 * real import code (startImport, addRows, finishUpload, runImport), the real
 * Path readers (readPathCounts, factsFrom) and the in-memory Redis stub.
 * Synthetic store and addresses only; nothing real is sent or changed.
 */
import { addRows, finishUpload, runImport, startImport, type ImportKind, type StartInput } from "@/lib/imports";
import { readAllListings } from "@/lib/catalog";
import { factsFrom, readPathCounts, readPathMoney } from "@/lib/path-facts";
import { readPaidSales, readLifeRecord } from "@/lib/stats";
import { readPayPalSales } from "@/lib/paypal-sales";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setPayPalSeller, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

/**
 * Stand-in for `fetch`: Stripe answers with the paid checkouts in `stripeSales`
 * (empty unless a part puts one there), and the email sender takes everything.
 * The Path money is read the way the Path reads it: through these answers.
 */
const stripeSales: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1", data: [{ id: "email_1" }] }));
  const path = url.pathname.replace(/^\/v1/, "");
  const data = path === "/checkout/sessions" ? stripeSales : [];
  return new Response(JSON.stringify({ object: "list", data, has_more: false }));
}) as typeof fetch;

const owner = "d7-path@example.test";

async function seed() {
  process.env.STRIPE_SECRET_KEY = "sk_test_d7_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_d7_only_a_stand_in";
  redis.clear();
  await claimHandle(owner, "d7path", "Synthetic path store", "A synthetic line about the store.");
  await ensureStatsId(owner);
  await ensureListId(owner);
  stripeSales.length = 0;
  // Stripe and PayPal both connected, so the Path reads real sales from both ledgers; an unconnected store would read none, whatever an import wrote.
  await setStripeAccount(owner, "acct_1TestD7Path0001", true);
  await setPayPalSeller(owner, "D7PAYPALMERCHANT");
  await setSubscription(owner, { customerId: "cus_D7Owner0001", subscriptionId: "sub_D7Owner0001", active: true, period: paidPeriod() });
}

async function runImportOf(kind: ImportKind, rows: string[][], input: Partial<StartInput> = {}) {
  const store = (await storeForEmail(owner))!;
  const started = await startImport(store, owner, kind, { expected: rows.length, file: `${kind}.csv`, ...input } as StartInput);
  if (!started.ok) throw new Error(`the ${kind} import must start: ${JSON.stringify(started)}`);
  const added = await addRows(store, started.job.id, rows);
  if (!added.ok) throw new Error(`rows refused: ${JSON.stringify(added)}`);
  await finishUpload(store, started.job.id);
  let finished = await runImport(started.job.id, Date.now() + 10_000);
  for (let i = 0; i < 20 && finished?.state !== "done"; i += 1) finished = await runImport(started.job.id, Date.now() + 10_000);
  return finished;
}

const facts = async () => {
  const store = (await storeForEmail(owner))!;
  const counts = await readPathCounts(store);
  const money = await readPathMoney(store);
  return { counts, money, facts: factsFrom(store, counts, money), store };
};

/** Every sale the Path could count: its own money reading, the PayPal ledger and the paid-sales reader both ledgers feed. */
const sales = async () => {
  const store = (await storeForEmail(owner))!;
  const paypal = await readPayPalSales(store.statsId, 0, 100);
  const paid = await readPaidSales(store, 0, 5);
  return [paypal.sales.length, paid.sales.length];
};

/** Every field of the all-time record that could count as an address left (the "fs:" channels the path reads, and "lc"). */
const leadFields = async () => {
  const store = (await storeForEmail(owner))!;
  const life = await readLifeRecord(store.statsId);
  return [...life.keys()].filter((f) => f === "lc" || f.startsWith("fs:") || f.startsWith("lc"));
};

async function main(): Promise<void> {
  await seed();
  part("A products import leaves drafts; publishing the one with a link meets the facts");
  const before = await facts();
  is("control: a fresh store has no listed product and no file", [before.facts.listedProducts, before.facts.productWithFile], [0, false]);
  const products = await runImportOf("products", [
    ["2", "Imported guide", "10", "A synthetic guide.", "paid", "https://example.com/guide"],
    ["3", "Imported draft without link", "5", "Nothing to hand over yet.", "paid", ""],
  ]);
  is("the products import finished with both added and no errors", [products?.state, products?.counts.added, products?.counts.errors], ["done", 2, 0]);
  const drafts = await facts();
  is("both are in the catalog but drafts: listedProducts 0, productWithFile false", [drafts.store.catalog.items.length, drafts.facts.listedProducts, drafts.facts.productWithFile], [2, 0, false]);

  // The imported guide is found by its title, not by import order.
  const guide = (await readAllListings(drafts.store)).find((p) => p.title === "Imported guide");
  if (!guide) throw new Error("the imported guide must exist");
  const shown = await setProductHidden(owner, guide.id, false);
  is("publishing the imported guide works", shown.ok, true);
  const published = await facts();
  is("after publishing, imported products meet the facts: listedProducts 1, productWithFile true", [published.facts.listedProducts, published.facts.productWithFile], [1, true]);
  is("publishing an import still makes no lead and no sale", [published.facts.leads, published.facts.realSales], [0, 0]);

  part("A contacts import leaves leads at 0");
  const contacts = await runImportOf("contacts", [
    ["2", "ana@example.test", "Ana", "", "yes"],
    ["3", "bob@example.test", "Bob", "", "yes"],
    ["4", "cy@example.test", "Cy", "", "yes"],
  ], { agreed: true });
  is("the contacts import added the three addresses", [contacts?.state, contacts?.counts.added, contacts?.counts.errors], ["done", 3, 0]);
  const afterContacts = await facts();
  is("readPathCounts leads stays 0 and the facts agree", [afterContacts.counts?.leads, afterContacts.facts.leads, afterContacts.facts.realSales], [0, 0, 0]);
  is("no lead field in the life record", await leadFields(), []);

  part("A purchases import leaves leads at 0 and touches no sale");
  const purchases = await runImportOf("purchases", [
    ["2", "buyer1@example.test", "Imported guide", "paid"],
    ["3", "buyer2@example.test", "Imported guide", "paid"],
  ], { email: false });
  is("the purchases import gave both purchases", [purchases?.state, purchases?.counts.added, purchases?.counts.errors], ["done", 2, 0]);
  const afterPurchases = await facts();
  is("leads stays 0 through the real path counts", [afterPurchases.counts?.leads, afterPurchases.facts.leads], [0, 0]);
  is("no lead field was written to the life record", await leadFields(), []);
  is("the Path read real money (not null), and it holds no sale", [afterPurchases.money !== null, afterPurchases.money?.real, afterPurchases.money?.cents], [true, 0, 0]);
  is("no real sale and no first-sale fact after the purchases import", [afterPurchases.facts.realSales, afterPurchases.facts.revenueCents], [0, 0]);
  is("neither the PayPal ledger nor the paid-sales reader holds a sale", await sales(), [0, 0]);

  part("A members import leaves leads at 0 and touches no sale");
  const club = await addProduct(owner, "Imported club", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("the membership must be added");
  await setProductLink(owner, club.product.id, "https://example.com/club");
  await setProductHidden(owner, club.product.id, false);
  const renews = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  const members = await runImportOf("members", [
    ["2", "mia@example.test", "Imported club", renews, ""],
    ["3", "noa@example.test", "Imported club", renews, ""],
  ], { stopped: true });
  // The invitations are written by the rows step; the emails that follow wait on the sender, which this test does not play, so the job may still be mailing.
  is("the members import invited both and no row failed", [["mailing", "done"].includes(members?.state ?? ""), members?.counts.added, members?.counts.errors], [true, 2, 0]);
  const afterMembers = await facts();
  is("leads stays 0 and no lead field was written", [afterMembers.counts?.leads, afterMembers.facts.leads, await leadFields()], [0, 0, []]);
  is("no real sale and no first-sale fact after the members import", [afterMembers.money?.real, afterMembers.facts.realSales, afterMembers.facts.revenueCents, await sales()], [0, 0, 0, [0, 0]]);

  part("Control: the same readers do count a real paid sale, so the checks above can fail");
  stripeSales.push({
    id: "cs_live_d7control0001", status: "complete", payment_status: "paid", livemode: true, created: Math.floor(Date.now() / 1000) - 60,
    amount_total: 6900, currency: "usd", payment_intent: "pi_d7control0001", metadata: { store: "d7path", product: club.product.id },
    customer_details: { email: "real@example.test" },
  });
  const counted = await facts();
  is("a live paid checkout is a real sale to the Path and to the paid-sales reader", [counted.money?.real, counted.facts.realSales, (await sales())[1]], [1, 1, 1]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
