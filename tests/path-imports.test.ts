/**
 * Queue item 10 [D7]: "an import never creates a confirmed lead nor a sale",
 * while imported products may still meet the Path facts. Exercised through the
 * real import code (startImport, addRows, finishUpload, runImport), the real
 * Path readers (readPathCounts, factsFrom) and the in-memory Redis stub.
 * Synthetic store and addresses only; nothing real is sent or changed.
 */
import { addRows, finishUpload, runImport, startImport, type ImportKind, type StartInput } from "@/lib/imports";
import { factsFrom, readPathCounts } from "@/lib/path-facts";
import { readLifeRecord } from "@/lib/stats";
import { claimHandle, ensureListId, ensureStatsId, setProductHidden, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const owner = "d7-path@example.test";

async function seed() {
  redis.clear();
  await claimHandle(owner, "d7path", "Synthetic path store", "A synthetic line about the store.");
  await ensureStatsId(owner);
  await ensureListId(owner);
}

async function runImportOf(kind: ImportKind, rows: string[][], input: Partial<StartInput> = {}) {
  const store = (await storeForEmail(owner))!;
  const started = await startImport(store, owner, kind, { expected: rows.length, file: `${kind}.csv`, ...input } as StartInput);
  if (!started.ok) throw new Error(`the ${kind} import must start: ${JSON.stringify(started)}`);
  const added = await addRows(store, started.job.id, rows);
  if (!added.ok) throw new Error(`rows refused: ${JSON.stringify(added)}`);
  await finishUpload(store, started.job.id);
  let finished = await runImport(started.job.id, Date.now() + 10_000);
  for (let i = 0; i < 5 && finished?.state !== "done"; i += 1) finished = await runImport(started.job.id, Date.now() + 10_000);
  return finished;
}

const facts = async () => {
  const store = (await storeForEmail(owner))!;
  const counts = await readPathCounts(store);
  return { counts, facts: factsFrom(store, counts, null), store };
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

  // The catalog keeps ids and kinds in import order (titles live in their own records): the first row is the guide with a link.
  const guide = drafts.store.catalog.items[0];
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
  is("real sales come only from Stripe money: none with no money read", [afterPurchases.facts.realSales, afterPurchases.facts.revenueCents], [0, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
