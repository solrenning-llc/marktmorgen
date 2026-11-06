/** D7 baseline integration evidence. Actual import/publication writers and Path readers; no product edits. */
import assert from "node:assert/strict";
import { Socket } from "node:net";
import { fetch as dispatcherFetch } from "undici";
import { claimHandle, ensureListId, ensureStatsId, setProductHidden, setStripeAccount, storeForEmail, updateDetails } from "@/lib/store";
import { addRows, finishUpload, runImport, startImport, type ImportKind, type StartInput } from "@/lib/imports";
import { readProduct } from "@/lib/catalog";
import { leadsKey, mailable, parseContact } from "@/lib/contacts";
import { importedFor } from "@/lib/imported-purchases";
import { readPathFacts, readPathMoney } from "@/lib/path-facts";
import { dayMissions, readAnswers } from "@/lib/path-rules";
import { readLifeRecord } from "@/lib/stats";
import { convertSavedPage, trimSavedPage } from "@/lib/clickfunnels-page";
import { saveFunnelImport } from "@/lib/clickfunnels-funnel";
import { readPage, writePage } from "@/lib/sales-page-store";
import { siteKey } from "@/lib/site-page-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Guard = { dispatcherAttempts: number; socketAttempts: number; unexpectedFetch: number };
const guard = (globalThis as typeof globalThis & { __jD7Network: Guard }).__jD7Network;
assert.ok(guard, "the runner must install transport guards before evaluating the application graph");
const OWNER = "j-dseven@example.test", CONTACT = "imported-dseven@example.test", HANDLE = "j-dseven";
const ACCOUNT = "acct_JDseven0001", LINK = "https://example.test/d7-guide";
let sessions: Record<string, unknown>[] = [];
const stripeReads: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? "GET";
  if (url.origin === "https://api.stripe.com" && method === "GET" && ["/v1/checkout/sessions", "/v1/payment_intents", "/v1/refunds"].includes(url.pathname) && new Headers(init?.headers).get("Stripe-Account") === ACCOUNT) {
    stripeReads.push(url.pathname);
    return Response.json({ object: "list", data: url.pathname === "/v1/checkout/sessions" ? sessions : [], has_more: false });
  }
  guard.unexpectedFetch++;
  throw new Error("D7 proof blocks every HTTP call outside its explicit synthetic Stripe GETs");
}) as typeof fetch;

async function current() {
  const store = await storeForEmail(OWNER);
  assert.ok(store, "the real store writer must have saved the synthetic store");
  return store;
}
async function importRows(kind: ImportKind, rows: string[][], options: Partial<StartInput> = {}) {
  const store = await current();
  const started = await startImport(store, OWNER, kind, { expected: rows.length, file: `d7-${kind}.csv`, email: false, ...options });
  assert.equal(started.ok, true, `real ${kind} import must start`);
  assert.equal((await addRows(store, started.job.id, rows)).ok, true, "actual importer must accept the uploaded rows");
  assert.equal((await finishUpload(store, started.job.id)).ok, true, "actual importer must queue the upload");
  let job = await runImport(started.job.id, Date.now() + 30_000);
  for (let step = 0; step < 5 && job && job.state !== "done"; step++) job = await runImport(started.job.id, Date.now() + 30_000);
  assert.ok(job, "the actual import job must remain readable");
  assert.equal(job.state, "done", "the real internal import flow must finish");
  assert.equal(job.counts.errors, 0, "setup must not disguise an import error as absence of a Path fact");
  return job;
}
async function facts() {
  const store = await current(), money = await readPathMoney(store);
  assert.ok(money, "the explicitly synthetic complete ledger must be readable");
  return readPathFacts(store, money);
}

async function main() {
  part("Transport guards are active before any scenario");
  let dispatcherBlocked = false;
  try { await dispatcherFetch("https://d7-network-blocked.invalid/probe"); }
  catch (error) { dispatcherBlocked = (error as { cause?: { code?: string } }).cause?.code === "UND_MOCK_ERR_MOCK_NOT_MATCHED"; }
  is("the SDK dispatcher denies an unmatched request without a real connection", dispatcherBlocked, true);
  let socketBlocked = false;
  const socket = new Socket();
  try { socket.connect({ host: "d7-network-blocked.invalid", port: 443 }); }
  catch (error) { socketBlocked = error instanceof Error && error.message === "D7 proof forbids network sockets"; }
  finally { socket.destroy(); }
  is("direct socket connections are also blocked before DNS or transport", socketBlocked, true);
  assert.ok(dispatcherBlocked && socketBlocked, "network guard setup must pass before executing any import");

  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_j_d7_synthetic_only";
  await claimHandle(OWNER, HANDLE, "D7 Synthetic Store", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const answer = readAnswers({ minutes: 15, audience: "none", timeZone: "America/New_York", goalCents: 0 }, "usd");
  assert.equal(answer.ok, true);
  if (!answer.ok) throw new Error("Synthetic Path answers were not valid");
  const mission = (read: Awaited<ReturnType<typeof facts>>, id: string) => dayMissions(read, answer.answers).find(row => row.id === id)?.state;
  const before = await facts();
  is("initial listed product, lead and real sale counts are confirmed empty", [before.listedProducts, before.leads, before.realSales], [0, 0, 0]);
  is("the store name without its own introduction does not close Day 1", mission(before, "title"), "open");

  part("A real product import, then real publication");
  const productJob = await importRows("products", [["2", "D7 Linked Guide", "19", "Synthetic guide", "paid", LINK]]);
  is("the importer reports one product really added", productJob.counts.added, 1);
  let store = await current();
  assert.equal(store.catalog.items.length, 1, "the imported product must exist in the saved catalog");
  const productId = store.catalog.items[0].id;
  const draft = await readProduct(store, productId);
  assert.ok(draft, "the importer must have persisted a real product");
  is("the actual imported product keeps its delivery link and remains hidden", [draft.link, draft.hidden], [LINK, true]);
  const hidden = await facts();
  is("an imported draft is not a listed product", hidden.listedProducts, 0);
  is("an imported hidden link does not close Day 2", [hidden.productWithFile, mission(hidden, "product")], [false, "open"]);
  const published = await setProductHidden(OWNER, productId, false);
  assert.equal(published.ok, true, "the real publication writer must confirm its save");
  const visible = await facts();
  is("real publication makes the imported product eligible", [visible.listedProducts, visible.productWithFile, mission(visible, "product")], [1, true, "done"]);
  is("product import and publication manufacture neither lead nor real sale", [visible.leads, visible.realSales], [0, 0]);

  part("Actual contact and purchase imports do not become Path acquisition or sales");
  const contactJob = await importRows("contacts", [["2", CONTACT, "Synthetic imported contact", "d7-import", "yes"]], { agreed: true, consentColumn: true });
  is("the actual contact import reports one added address", contactJob.counts.added, 1);
  store = await current();
  const [raw] = await redis.pipeline([["HGET", leadsKey(store.listId!), CONTACT]]);
  const contact = parseContact(raw);
  assert.ok(contact, "the imported contact must really be persisted");
  is("the imported contact has reported agreement and its import origin", [contact.agreed, contact.source, mailable(contact)], [true, "import", true]);
  const afterContact = await facts();
  is("reported imported consent does not create a confirmed Path lead", [afterContact.leads, mission(afterContact, "lead")], [0, "open"]);
  const purchaseJob = await importRows("purchases", [["2", CONTACT, productId, "Paid"]], { email: false });
  is("the actual purchase import reports one grant without email", [purchaseJob.counts.added, purchaseJob.options.email, purchaseJob.counts.mailed], [1, false, 0]);
  store = await current();
  const grants = await importedFor(store, CONTACT);
  is("the real imported-purchase record names this product and import job", grants.map(row => [row.productId, row.job]), [[productId, purchaseJob.id]]);
  const afterPurchase = await facts();
  is("imported purchases are not a Path sale or revenue", [afterPurchase.realSales, afterPurchase.revenueCents, mission(afterPurchase, "sale")], [0, 0, "open"]);
  is("imported purchases also leave Path leads unchanged", afterPurchase.leads, 0);
  is("neither import created an fs acquisition field", [...(await readLifeRecord(store.statsId)).keys()].some(key => key.startsWith("fs:")), false);

  part("An unrelated imported page is not the store's own name and introduction");
  const pageDraft = convertSavedPage(trimSavedPage("<html><head><title>Imported D7 page</title></head><body><h1>A page brought over</h1><p>Synthetic saved words.</p></body></html>"), "d7-page.html");
  const saved = await saveFunnelImport(store, { name: "D7 page import", pages: [{ file: "d7-page.html", role: "page", product: "", bumps: [], draft: pageDraft }] });
  assert.equal(saved.ok, true, "the actual saved-page import must finish");
  store = await current();
  assert.equal(store.sitePages.length, 1, "the page must exist in the real store record");
  const pageId = siteKey(store.sitePages[0].id), page = await readPage(store.statsId, pageId);
  is("the actual imported page has native blocks and is initially hidden", [page.hidden, page.blocks.length > 0], [true, true]);
  assert.ok(store.statsId);
  await writePage(store.statsId, pageId, { ...page, hidden: false }, store);
  is("the real page writer confirms the page is now visible", (await readPage(store.statsId, pageId)).hidden, false);
  is("publishing an unrelated page cannot manufacture the store's Day 1 fact", mission(await facts(), "title"), "open");
  await updateDetails(OWNER, "D7 Synthetic Store", "A real saved store introduction.");
  is("the actual own-store introduction writer does close Day 1", mission(await facts(), "title"), "done");

  part("The live-sale reader still responds only to its own server ledger");
  sessions = [{ id: "cs_test_jDseven0001", object: "checkout.session", status: "complete", payment_status: "paid", amount_total: 1900, currency: "usd", created: Math.floor(Date.now() / 1000), livemode: true, payment_intent: "pi_jDseven0001", metadata: { store: HANDLE, product: productId } }];
  const ledgerSale = await facts();
  is("one explicitly synthetic live-mode server checkout is counted, not the imported grant", [ledgerSale.realSales, ledgerSale.revenueCents, mission(ledgerSale, "sale")], [1, 1900, "done"]);
  sessions = [];
  is("removing that synthetic server sale leaves only the non-sale import", [(await facts()).realSales, (await importedFor(await current(), CONTACT)).length], [0, 1]);
  is("all expected provider observations were intercepted Stripe GETs", stripeReads.length > 0 && stripeReads.every(path => ["/v1/checkout/sessions", "/v1/payment_intents", "/v1/refunds"].includes(path)), true);
  is("SDK dispatcher saw only its deliberate blocked control", guard.dispatcherAttempts, 1);
  is("socket layer saw only its deliberate blocked control", guard.socketAttempts, 1);
  is("no email, link fetch, Blob, other provider or startup HTTP was attempted", guard.unexpectedFetch, 0);
  console.log(JSON.stringify({ source: "2bfa8ade8f59555b8d57aa03e554a99092a1285b", imports: [productJob.kind, contactJob.kind, purchaseJob.kind, "saved page"], stripeGetCounts: Object.fromEntries([...new Set(stripeReads)].map(path => [path, stripeReads.filter(value => value === path).length])), network: "MockAgent.disableNetConnect plus socket denial before module evaluation", redis: "canonical MemoryRedis; isolated process", result: "existing D7 behavior observed; no product change" }));
  done();
}
main().catch(error => { console.error("D7 setup or execution failure; not automatically a product RED", error); process.exitCode = 1; });
