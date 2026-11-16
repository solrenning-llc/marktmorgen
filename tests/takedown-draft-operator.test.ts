/**
 * Claude 4 (cloud AE) on #3597 @497fcbb51a, MÉDIO and LEVE 1. A notice about a draft's preview address points at the
 * draft (lib/takedown.ts reportedProduct), but the operator's page (app/takedown/[token]/page.tsx) listed only the
 * store's published products, so the draft the notice names showed no button and its preview link could not be
 * closed from the page. And a preview record that could not be read was shown as a notice pointing at nothing.
 *
 * What must hold: the operator sees the draft the notice names, marked as a draft, with the button that closes its
 * preview link (operatorProducts); no other draft is listed; the page is the operator's only, so nothing is shown to
 * the public. An unreadable read is unknown, never "no product": reportedProduct throws and the page says the
 * product could not be checked. Synthetic store; MemoryRedis; no email.
 */
import { readFileSync } from "node:fs";
import * as takedown from "@/lib/takedown";
import { reportedProduct } from "@/lib/takedown";
import { readReport } from "@/lib/takedown-rules";
import { makeDraftPreview } from "@/lib/draft-preview";
import { addProduct, claimHandle, ensureStatsId, setProductHidden, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Listed = { product: { id: string }; draft: boolean; named: boolean };
const owner = "draft-operator@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(owner, "draftoperator", "Draft Operator", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_draftop0001", subscriptionId: "sub_draftop0001", active: true, period: paidPeriod() });
  const named = await addProduct(owner, "Named Draft", "", "9", null);
  const other = await addProduct(owner, "Other Draft", "", "9", null);
  const live = await addProduct(owner, "Live Pack", "", "9", null);
  if (!named.ok || !other.ok || !live.ok) throw new Error("setup");
  await setProductHidden(owner, named.product.id, true);
  await setProductHidden(owner, other.product.id, true);
  const store = (await storeForEmail(owner))!;
  const link = await makeDraftPreview(store, named.product.id);
  const read = readReport({
    kind: "other", url: `https://marktmorgen.com/@draftoperator/preview/${link.code}`, work: "Synthetic notice about a draft's preview link.",
    name: "Rita Reporter", email: "rita@example.com", contact: "", signature: "Rita Reporter", goodFaith: true, accurate: true,
  });
  if (!read.ok) throw new Error("notice");
  const report = { ...read.report, id: "a1b2c3d4e5f60718", at: new Date().toISOString(), handle: "draftoperator" };

  part("The operator sees the draft the notice names, with its button");
  const pointed = await reportedProduct(report, store);
  is("the notice points at the draft", pointed?.id, named.product.id);
  const pick = (takedown as Record<string, unknown>).operatorProducts as undefined | ((s: typeof store, p: typeof pointed) => Listed[]);
  is("the page's list of products is chosen by one function the tests can run", typeof pick, "function");
  const listed = pick ? pick(store, pointed) : [];
  const first = listed[0];
  is("the named draft comes first, marked as a draft and as the one the notice names", [first?.product.id, first?.draft, first?.named], [named.product.id, true, true]);
  is("no other draft is listed", listed.some((l) => l.product.id === other.product.id), false);
  is("the published products are listed as before", listed.some((l) => l.product.id === live.product.id && !l.draft && !l.named), true);
  const page = readFileSync("app/takedown/[token]/page.tsx", "utf8");
  is("the page lists what operatorProducts chooses", page.includes("operatorProducts(store, pointed)"), true);
  is("a draft's button says it closes its preview link", page.includes("Close this draft's preview link"), true);

  part("An unreadable read is unknown, never a notice pointing at nothing");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => String(c[1] ?? "").startsWith("nl:dpv:"))) return commands.map(() => ({ garbled: true }));
    return real(commands);
  }) as typeof redis.pipeline;
  let threw = false;
  try {
    await reportedProduct(report, store);
  } catch {
    threw = true;
  } finally {
    redis.pipeline = real;
  }
  is("reportedProduct throws when the preview record cannot be read", threw, true);
  is("the page says the product could not be checked", page.includes("We could not check which product the notice points at."), true);
  is("an address that is not one at all still points at nothing", await reportedProduct({ ...report, url: "not a url" }, store), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
