/**
 * Every studio request that reads the store's buyers or all its sales from
 * Stripe again counts that reading in the studio's requests before it reads
 * (MR: a ceiling before every spend), not only the tasks agenda:
 *
 *   - the email composer's count and a narrowed email written down (the
 *     buyers, lib/segments.ts buyerLedger, through createBroadcast's count);
 *   - telling a product's buyers of an update (every paid sale,
 *     lib/product-updates.ts updateReadUnits);
 *   - asking the store's numbers (read as the studio's home page reads them,
 *     STUDIO_PAGE_UNITS);
 *
 * and, when it is not counted, nothing is read or written and the studio
 * says how many this needs and how many are left.
 */
import { readFileSync } from "node:fs";
import { createBroadcast } from "@/lib/broadcasts";
import { broadcastAnswer } from "@/lib/broadcast-response";
import { startUpdate, updateReadUnits } from "@/lib/product-updates";
import { BUYER_LEDGER_UNITS, LedgerNotCounted, ledgerReadBytes, ledgerUnits } from "@/lib/segments";
import { countLedger } from "@/lib/person-agenda-read";
import { readListing } from "@/lib/catalog";
import { redisPipeline } from "@/lib/redis";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "ledger-owner@example.com";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") stripeCalls += 1;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const studioKey = () => redis.keys().find((key) => key.startsWith("nl:allow:studio:"));
const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_ledger_only_a_stand_in";
  await claimHandle(OWNER, "ledgershop", "Ledger Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLedger0001", true);
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Lee at Ledger", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(OWNER, "Ledger Guide", "", "27", null);
  if (!made.ok) throw new Error("no product");
  const load = async () => (await storeForEmail(OWNER))!;

  part("A narrowed email written down counts its reading of the buyers first");
  const store = await load();
  const counting = countLedger(store);
  // Room for the page's own request only: reading Stripe again needs BUYER_LEDGER_UNITS.
  const { countStudio } = await import("@/lib/studio-route");
  await countStudio(store, null, 1);
  await redisPipeline([["SET", studioKey()!, String(allowanceFor(store, "studio") - 3)]]);
  const written = () => redis.keys().filter((key) => key.startsWith("nl:mail:")).sort();
  stripeCalls = 0;
  const refused = await createBroadcast(store, { subject: "Hello", body: "News for our best buyers.", productId: "", notProductId: "", sendAt: undefined, who: "all", narrow: { minSpent: 5000 } }, counting.count).then(
    (r) => (r.ok ? "written" : r.reason),
    (error: unknown) => (error instanceof LedgerNotCounted ? "not counted" : String(error)),
  );
  is("with fewer studio requests left than reading Stripe again needs, nothing is read from Stripe or written", [refused, stripeCalls, written()], ["not counted", 0, []]);
  is("and the refusal says how many this needs and how many are left", counting.said.message.startsWith(`This needs ${BUYER_LEDGER_UNITS} of your studio requests, and only 3 are left.`), true);
  is("the composer is told so, not that the write is unknown", broadcastAnswer(false, { ok: false, error: "studio_used", message: counting.said.message }, {}), { ok: false, error: "studio_used", message: counting.said.message });

  part("Telling a product's buyers of an update counts every paid sale it reads first");
  const product = (await readListing(await load(), made.product.id))!;
  stripeCalls = 0;
  const spent = await startUpdate(await load(), product, "");
  is("with fewer left than it needs, it is refused with the sentence, and Stripe is not read", [spent.ok ? "started" : spent.reason, !spent.ok && spent.reason === "studio_used" && spent.message.startsWith(`This needs ${updateReadUnits(0)} of your studio requests, and only 3 are left.`), stripeCalls], ["studio_used", true, 0]);
  is("a reading of the buyers' worth, with the PayPal sales kept by their weight", [updateReadUnits(0), updateReadUnits(300)], [BUYER_LEDGER_UNITS, BUYER_LEDGER_UNITS + ledgerUnits(ledgerReadBytes({ imported: 0, paypalSales: 300, paypalRefunds: 0 }))]);
  await redisPipeline([["SET", studioKey()!, "0"]]);
  const read = await startUpdate(await load(), product, "");
  is("with room, it counts them and then reads Stripe", [read.ok ? "started" : read.reason, Number((await redisPipeline([["GET", studioKey()!]]))[0]), stripeCalls > 0], ["none", updateReadUnits(0), true]);

  part("The routes and the studio");
  const mail = flat("app/api/store/mail/route.ts");
  is("the composer's count counts its reading of the buyers, and says the refusal's sentence", [mail.includes("const ledger = await buyerLedger(store, counting.count)"), mail.includes("if (ledger instanceof LedgerNotCounted) return notCounted(counting.said.message);"), mail.includes('Response.json({ ok: false, error: "studio_used", message: message || NOT_COUNTED }, { status: 429 })')], [true, true, true]);
  is("a narrowed email written down counts it too", [mail.includes("}, counting.count).catch((error) => {"), mail.includes("if (created instanceof LedgerNotCounted) return notCounted(counting.said.message);")], [true, true]);
  is("nowhere in the mail route is the store's buyers read uncounted", mail.includes("buyerLedger(store)"), false);
  const update = flat("app/api/store/product-update/route.ts");
  is("the update's refusal carries its sentence", update.includes('error: "studio_used", message: started.message ||'), true);
  const ask = flat("app/api/store/numbers/ask/route.ts");
  is("asking the numbers counts their reading as their page does, before reading them", ask.indexOf("countUnits(store, STUDIO_PAGE_UNITS - 1)") > 0 && ask.indexOf("countUnits(store, STUDIO_PAGE_UNITS - 1)") < ask.indexOf("readNumbers(store)"), true);
  const composer = flat("components/email-studio.tsx");
  is("the composer shows the sentence, on the count as on a send", [composer.includes('a.error === "studio_used" && typeof a.message === "string" && a.message ? a.message'), composer.includes('} else if (a.error === "stripe" || a.error === "studio_used") setError(message(a));')], [true, true]);
  is("so do the update box and the numbers question", [flat("components/product-update-box.tsx").includes('data.error === "studio_used" && typeof data.message === "string" && data.message ? `${data.message} Nothing was sent.`'), flat("components/numbers-ask.tsx").includes('else if (data.error === "studio_used" && typeof data.message === "string" && data.message) setError(data.message);')], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
