/**
 * 623 [SZ7], unit 3: the one email when a sold-out limited product is back.
 *
 * Acceptance (docs/codex-queue.md, 623): a restock sends one email to each
 * confirmed address and deletes the list; an address that never confirmed
 * gets nothing. Each batch is taken from the store's emails before it goes;
 * a batch tried again keeps its key, so nobody is written to twice; a send
 * that failed, a spent figure or a read out of shape keeps everything and
 * waits (never dropped); somebody who left meanwhile is skipped; each run
 * stops at its ceilings. Synthetic Redis and email service only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setProductExtras, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { STOCK_ALERT_DUE, askStockAlert, confirmStockAlert, dueMember, forgetStockAlertPerson, leaveStockAlert } from "@/lib/stock-alerts";
import { RESTOCK_BATCH, RESTOCK_RUN_PRODUCTS, RESTOCK_WAIT_MS, type RestockDeps, runRestocks } from "@/lib/stock-alert-send";
import { readListing } from "@/lib/catalog";
import { stockLeft } from "@/lib/stock";
import { storeForIdExactly } from "@/lib/store-exact";
import { sendBatch, type BatchMessage, type EmailMeter } from "@/lib/email";
import { STOCK_ALERT_WORDS } from "@/lib/buyer-words/stock-alert";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Sent = { to: string[]; subject: string; text: string; html: string; headers?: Record<string, string> };
const batches: { batch: Sent[]; key: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    const batch = JSON.parse(String(init?.body)) as Sent[];
    batches.push({ batch, key: new Headers(init?.headers).get("Idempotency-Key") ?? "" });
    return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const OWNER = "owner@example.com";
const POSTAL = "12 Harbor Road, Portland, ME 04101";

/** A send that answers `outcome` and keeps what it was asked to send. */
function sender(outcome: "sent" | "retry" | "refused") {
  const calls: { messages: BatchMessage[]; key: string; meter: EmailMeter }[] = [];
  const send = (async (messages: BatchMessage[], key: string, meter: EmailMeter) => {
    calls.push({ messages, key, meter });
    return outcome;
  }) as typeof sendBatch;
  return { calls, send };
}

const real: RestockDeps = { load: storeForIdExactly, readProduct: readListing, left: (s, p) => stockLeft(s, p), send: sendBatch };

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle(OWNER, "harbor", "Harbor Prints", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_harbor", subscriptionId: "sub_harbor", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Prints", address: POSTAL });
  const made = await addProduct(OWNER, "Signed Print", "", "40", null);
  if (!made.ok) throw new Error("no product");
  const pid = made.product.id;
  await setProductExtras(OWNER, pid, { stock: 1 });
  let store = (await storeForEmail(OWNER)) as Store;
  const sid = store.statsId!;
  const member = dueMember(store.sid!, pid);
  // The one unit is sold.
  redis.run(["HSET", `nl:stock:${sid}:${pid}`, "cs_sold", JSON.stringify({ until: 0, paid: true })]);
  is("sold out", await stockLeft(store, (await readListing(store, pid))!), 0);

  const listKey = `nl:sa:${sid}:${pid}`;
  const due = () => redis.run(["ZSCORE", STOCK_ALERT_DUE, member]);
  const makeDue = () => redis.run(["ZADD", STOCK_ALERT_DUE, 0, member]);
  const place = async (email: string, confirm = true) => {
    const asked = await askStockAlert({ store, productId: pid, email, left: 0 });
    if (!asked.ok) throw new Error(`not asked: ${email}`);
    if (confirm) await confirmStockAlert(asked.confirm, store);
    return asked;
  };

  part("Confirming puts the product on the job's list");
  is("nothing due before anyone confirmed", due(), null);
  await place("ana@example.com", false);
  is("an address that did not confirm puts nothing there", due(), null);
  await place("ben@example.com");
  await place("cleo@example.com");
  is("a confirmed address does", typeof due(), "string");

  part("Still sold out: nothing is sent, and the product is looked at again later");
  makeDue();
  const before = Date.now();
  is("no email", await runRestocks(Date.now() + 30_000, real), 0);
  is("no batch", batches.length, 0);
  is("looked at again after the wait", Number(due()) >= before + RESTOCK_WAIT_MS, true);
  is("the list is whole", redis.run(["HLEN", listKey]), 3);

  part("Units left that cannot be read: unknown, nothing sent, never 'back'");
  makeDue();
  const broken = sender("sent");
  is("no email", await runRestocks(Date.now() + 30_000, { ...real, left: async () => { throw new Error("Stock reading unavailable"); }, send: broken.send }), 0);
  is("nothing asked of the email service", broken.calls.length, 0);
  is("waits", Number(due()) > Date.now(), true);

  part("Back in stock: one email to each confirmed address, then the list is deleted");
  await setProductExtras(OWNER, pid, { stock: 2 });
  store = (await storeForEmail(OWNER)) as Store;
  makeDue();
  is("two emails", await runRestocks(Date.now() + 30_000, real), 2);
  is("one batch", batches.length, 1);
  const [sent] = batches;
  is("to the confirmed addresses only", sent.batch.map((m) => m.to[0]).sort(), ["ben@example.com", "cleo@example.com"]);
  const mail = sent.batch[0];
  is("subject", mail.subject, "Signed Print is back in stock");
  is("the product's link, in the text", mail.text.includes(`/@harbor/p/`), true);
  is("the creator's postal address, in the text and the HTML", [mail.text.includes(POSTAL), mail.html.includes(POSTAL)], [true, true]);
  is("a stop link, in the text", mail.text.includes("/@harbor/back-in-stock?leave="), true);
  is("one-click unsubscribe for mail apps", [mail.headers?.["List-Unsubscribe"]?.includes("/api/store/stock-alert/leave?h=harbor&t=") ?? false, mail.headers?.["List-Unsubscribe-Post"]], [true, "List-Unsubscribe=One-Click"]);
  is("no picture, so nothing to track an opening", /<img\b/i.test(mail.html), false);
  is("in the store's language", mail.html.includes('lang="en-US"'), true);
  is("sent under a key made of the batch", sent.key.startsWith(`stock-alert:${sid}:${pid}:`), true);
  is("the confirmed addresses are gone, the one that never confirmed is still there", redis.run(["HKEYS", listKey]), ["ana@example.com"]);
  is("the batch record is gone", redis.run(["EXISTS", `${listKey}:job`]), 0);
  is("next run: back, and nobody confirmed left, so the list goes whole and the product leaves the job", [await runRestocks(Date.now() + 30_000, real), redis.run(["HLEN", listKey]), due()], [0, 0, null]);
  const leaveLinksLeft = redis.keys().filter((k) => k.startsWith("nl:sa:t:") && String(redis.run(["GET", k])).includes('"k":"leave"'));
  is("every leave link went with it", leaveLinksLeft, []);
  is("still one batch: nobody written to twice", batches.length, 1);

  part("A send that failed keeps everything; tried again under the same key");
  await place("dee@example.com");
  await place("eli@example.com");
  makeDue();
  const failing = sender("retry");
  is("nothing sent", await runRestocks(Date.now() + 30_000, { ...real, send: failing.send }), 0);
  is("asked once, as the store's emails", [failing.calls.length, failing.calls[0]?.meter.by, failing.calls[0]?.meter.by === "store" && failing.calls[0].meter.kind], [1, "store", "email"]);
  is("both addresses kept", redis.run(["HLEN", listKey]) as number >= 2, true);
  is("waits", Number(due()) > Date.now(), true);
  makeDue();
  const refused = sender("refused");
  is("a refusal (a spent figure) sends nothing either", await runRestocks(Date.now() + 30_000, { ...real, send: refused.send }), 0);
  is("the same batch, under the same key", [refused.calls[0]?.key, refused.calls[0]?.messages.map((m) => m.to).sort()], [failing.calls[0].key, ["dee@example.com", "eli@example.com"]]);
  is("still kept", redis.run(["HEXISTS", listKey, "dee@example.com"]), 1);

  part("Somebody who left meanwhile is skipped");
  const eliLeave = (await place("eli@example.com")).leave;
  is("left", await leaveStockAlert(eliLeave, store), true);
  makeDue();
  const third = sender("sent");
  is("one email", await runRestocks(Date.now() + 30_000, { ...real, send: third.send }), 1);
  is("only to who is still there, still under the same key", [third.calls[0].messages.map((m) => m.to), third.calls[0].key], [["dee@example.com"], failing.calls[0].key]);

  part("Sent, but the clean-up did not come back as asked: tried again under the same key, never a new batch");
  redis.run(["DEL", listKey]);
  await place("fay@example.com");
  makeDue();
  const run = redis.run.bind(redis);
  redis.run = (c: (string | number)[]) => (String(c[0]).toUpperCase() === "HDEL" && c[1] === listKey ? "garbage" : run(c));
  const first = sender("sent");
  await runRestocks(Date.now() + 30_000, { ...real, send: first.send });
  redis.run = run;
  is("sent once", first.calls.length, 1);
  is("the batch is kept", redis.run(["EXISTS", `${listKey}:job`]), 1);
  // Codex U on #3620: the email goes before the clean-up, so it never says the address is already deleted.
  const already: Record<string, RegExp> = {
    en: /is now deleted|has been deleted/i,
    es: /ya se ha borrado/i,
    fr: /maintenant supprimée/i,
    de: /ist jetzt daraus gelöscht/i,
    it: /ora è stato cancellato/i,
    nl: /er nu uit gewist/i,
    pt: /já foi apagado/i,
  };
  is("the email sent while its clean-up was still to come never says the address is already deleted", [
    redis.run(["HEXISTS", listKey, "fay@example.com"]),
    already.en.test(first.calls[0].messages[0].text),
  ], [1, false]);
  is("in no language", Object.entries(already).filter(([lang, done]) => done.test(STOCK_ALERT_WORDS[lang as keyof typeof STOCK_ALERT_WORDS].backAfter)).map(([lang]) => lang), []);
  makeDue();
  const second = sender("sent");
  await runRestocks(Date.now() + 30_000, { ...real, send: second.send });
  is("tried again as the same batch under the same key, which the email service sends to nobody twice", second.calls[0]?.key, first.calls[0].key);
  is("then cleaned up", [redis.run(["HEXISTS", listKey, "fay@example.com"]), redis.run(["EXISTS", `${listKey}:job`])], [0, 0]);

  part("The Portuguese words are Portugal's (the store's pt locale is pt-PT; Codex U on #3620)");
  const pt = STOCK_ALERT_WORDS.pt;
  const ptText = Object.values(pt).flatMap((v): string[] =>
    typeof v === "string" ? [v] : typeof v === "function" ? [(v as (...a: string[]) => string)("Loja Lanterna", "Gravura Assinada", "40 €")] : Object.values(v as Record<string, { title: string; body: string }>).flatMap((n) => [n.title, n.body]),
  ).join("\n");
  is("no Brazilian forms", ["você", "estoque", "apert", "digitad", "deu errado", "me avise", "olhe no"].filter((w) => ptText.toLowerCase().includes(w)), []);

  part("A person erased while their batch waits is not written to");
  await place("gus@example.com");
  makeDue();
  await runRestocks(Date.now() + 30_000, { ...real, send: sender("retry").send });
  await forgetStockAlertPerson(sid, [pid], "gus@example.com");
  makeDue();
  const afterErase = sender("sent");
  await runRestocks(Date.now() + 30_000, { ...real, send: afterErase.send });
  is("nothing asked of the email service for nobody", afterErase.calls.length, 0);
  is("the batch is gone", redis.run(["EXISTS", `${listKey}:job`]), 0);

  part("Ceilings: a batch at most per product each run, and RESTOCK_RUN_PRODUCTS products");
  redis.run(["DEL", listKey]);
  for (let i = 0; i < RESTOCK_BATCH + 5; i += 1) await place(`reader${i}@example.com`);
  makeDue();
  const big = sender("sent");
  is("one batch this run", await runRestocks(Date.now() + 30_000, { ...real, send: big.send }), RESTOCK_BATCH);
  is("the rest next run", await runRestocks(Date.now() + 30_000, { ...real, send: big.send }), 5);
  let loads = 0;
  for (let i = 0; i < RESTOCK_RUN_PRODUCTS + 3; i += 1) redis.run(["ZADD", STOCK_ALERT_DUE, 0, dueMember("e".repeat(32), `p${i}`)]);
  await runRestocks(Date.now() + 30_000, { ...real, load: async () => { loads += 1; return "unknown"; } });
  is("no more products looked at than the ceiling", loads <= RESTOCK_RUN_PRODUCTS, true);
  is("a store that cannot be read waits, never leaves the job", redis.run(["ZCARD", STOCK_ALERT_DUE]) as number >= RESTOCK_RUN_PRODUCTS + 3, true);
  redis.run(["ZADD", STOCK_ALERT_DUE, 0, dueMember("e".repeat(32), "p0")]);
  await runRestocks(Date.now() + 30_000, { ...real, load: async () => "none" });
  is("a store that is gone, exactly, leaves it", redis.run(["ZSCORE", STOCK_ALERT_DUE, dueMember("e".repeat(32), "p0")]), null);

  part("The products due, read out of shape: unknown, nothing sent");
  makeDue();
  redis.run = (c: (string | number)[]) => (String(c[0]).toUpperCase() === "ZRANGEBYSCORE" ? "garbage" : run(c));
  const shape = sender("sent");
  is("no email", await runRestocks(Date.now() + 30_000, { ...real, send: shape.send }), 0);
  redis.run = run;
  is("nothing asked", shape.calls.length, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
