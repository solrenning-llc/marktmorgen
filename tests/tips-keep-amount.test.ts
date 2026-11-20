/**
 * The support box keeps what the supporter already gave when it comes back with a notice (WCAG 3.3.7, redundant
 * entry; follow-up of 789 [IV1] unit 1, B, asked by Claude 3 and Codex X6 on #4919): the amount chosen, the amount
 * typed and, after a notice about the amount, the billing country. Never the country refused ("abroad") or missing
 * ("country"). Only values the box itself offers are put back; anything else is dropped, never shown.
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, setTips, storeForEmail, type Store } from "@/lib/store";
import { BILLING_COUNTRY_FIELD } from "@/lib/eu-vat-evidence";
import { POST as tipRoute } from "@/app/api/store/tip/route";
import { StoreTipBox } from "@/components/store-tip-box";
import { tipAmounts, tipKept } from "@/lib/store-tips";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_tips_keep_amount_only";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: `cs_test_${"k".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }))) as typeof fetch;

const SHOP = "tipkeepamount";
const OWNER = "tipkeepamount@example.com";

const ask = (ip: string | null, fields: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const headers: Record<string, string> = { host: "marktmorgen.com", origin: "https://marktmorgen.com" };
  if (ip) headers["x-vercel-ip-country"] = ip;
  return new NextRequest("https://marktmorgen.com/api/store/tip", { method: "POST", body: form, headers });
};

async function html(node: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(node, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, SHOP, "Tip Keep Amount", "");
  await ensureStatsId(OWNER);
  await setTips(OWNER, { on: true, heading: "", line: "", amounts: [] });
  await setStripeAccount(OWNER, "acct_1TipKeepAmount1", true);
  await setSubscription(OWNER, { customerId: "cus_TipKeepAmnt1", subscriptionId: "sub_TipKeepAmnt1", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const offered = tipAmounts(store.tips, store.currency);
  const preset = String(offered[1]);
  const tip = async (ip: string | null, fields: Record<string, string>) => {
    const response = await tipRoute(ask(ip, { handle: SHOP, ...fields }));
    return new URL(response.headers.get("location") ?? "", "https://marktmorgen.com");
  };

  part("The route sends back what was given, beside the notice");
  let back = await tip("US", { amount: preset, other: "20", [BILLING_COUNTRY_FIELD]: "US" });
  is("RED: amount: the chosen amount, the typed one and the country go back", [back.searchParams.get("tip"), back.searchParams.get("chose"), back.searchParams.get("other"), back.searchParams.get("from")], ["amount", preset, "20", "US"]);
  back = await tip("US", { amount: "other", other: "", [BILLING_COUNTRY_FIELD]: "CA" });
  is("RED: amount: another amount chosen and left empty, with the country", [back.searchParams.get("chose"), back.searchParams.get("other"), back.searchParams.get("from")], ["other", null, "CA"]);
  back = await tip("US", { amount: preset });
  is("country: the amount goes back, and no country (none was given)", [back.searchParams.get("tip"), back.searchParams.get("chose"), back.searchParams.get("from")], ["country", preset, null]);
  back = await tip("DE", { amount: "other", other: "7.50", [BILLING_COUNTRY_FIELD]: "DE" });
  is("abroad: the amount goes back, the refused country never", [back.searchParams.get("tip"), back.searchParams.get("chose"), back.searchParams.get("other"), back.searchParams.get("from")], ["abroad", "other", "7.50", null]);
  back = await tip("US", { amount: "99999", other: "<b>1</b>", [BILLING_COUNTRY_FIELD]: "ZZ" });
  is("nothing the box does not offer goes back: an amount it does not offer, markup typed, an unknown country", [back.searchParams.get("chose"), back.searchParams.get("other"), back.searchParams.get("from")], [null, null, null]);
  is("the notice and the place on the page are kept", [back.pathname, back.hash], [`/@${SHOP}`, "#support"]);

  part("The store page reads it only as the box offers it");
  is("RED: a known amount, a typed amount and a country", tipKept(store, { chose: preset, other: "20", from: "us" }), { chose: preset, other: "20", from: "US" });
  is("RED: anything else is dropped", tipKept(store, { chose: "99999", other: "javascript:1", from: "us1" }), { chose: "", other: "", from: "" });
  is("RED: a list or nothing is dropped too", tipKept(store, { chose: ["1", "2"], other: undefined, from: ["US"] }), { chose: "", other: "", from: "" });

  part("The box puts it back");
  const drawn = await html(StoreTipBox({ store, problem: "amount", rehearsal: false, kept: { chose: preset, other: "20", from: "US" } }));
  is("the chosen amount is checked", new RegExp(`<input[^>]*id="support-amount-${preset}"[^>]*checked`).test(drawn), true);
  is("only that one", (drawn.match(/<input[^>]*type="radio"[^>]*checked/g) ?? []).length, 1);
  is("the typed amount is in its box", /<input[^>]*name="other"[^>]*value="20"/.test(drawn), true);
  is("RED: the country is chosen, and only that one", [/<option[^>]*value="US"[^>]*selected/.test(drawn), (drawn.match(/<option[^>]*selected/g) ?? []).length], [true, 1]);
  const fresh = await html(StoreTipBox({ store, problem: "", rehearsal: false }));
  is("a first visit chooses nothing", [/type="radio"[^>]*checked/.test(fresh), /<option[^>]*value="[A-Z]{2}"[^>]*selected/.test(fresh)], [false, false]);

  done();
}

void main();
