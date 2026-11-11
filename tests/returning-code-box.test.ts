/**
 * The buy form's field for a code only for people who already bought from
 * this store (554 [DS1], unit 2; components/returning-code-box.tsx).
 *
 * What must hold:
 *   - shown only on the buy form of a store with a code still running, that
 *     can sell, on a price the creator set; nowhere else, so no store shows
 *     a field that does nothing;
 *   - closed and empty, so nothing is sent to be checked unless the buyer
 *     types a code; its two boxes have visible labels tied to them, and the
 *     notes are tied to the boxes they explain;
 *   - inside the form that opens the checkout, sending `rcode` and `remail`,
 *     the names the route reads;
 *   - every sentence, each reason a code is not taken included, in each of
 *     the seven languages a store can speak, and not left in English.
 *
 * Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setReturningCodes, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { BuyBox } from "@/components/store-product";
import { RETURNING_CODE_WORDS } from "@/lib/buyer-words/returning-code";
import { RETURNING_REFUSALS } from "@/lib/returning-code-rules";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "returning.box@example.com";

async function main(): Promise<void> {
  redis.clear();
  // Stand-ins only, so the form is drawn as on a store that can sell: nothing is sent anywhere.
  process.env.STRIPE_SECRET_KEY = "sk_test_returning_box_only";
  process.env.RESEND_API_KEY = "re_test_returning_box_only";
  await claimHandle(OWNER, "returnbox", "Return Box", "Synthetic store.");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRetBox01", true);
  await setSubscription(OWNER, { customerId: "cus_ReturnBox0001", subscriptionId: "sub_ReturnBox0001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Recipe pack", "", "27", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/pack");

  const form = async () => {
    const store = (await storeForEmail(OWNER))!;
    const product = (await readListing(store, made.product.id))!;
    return renderToStaticMarkup(createElement(BuyBox, { store, product, related: [], remaining: null, writes: true, selling: true }));
  };

  part("A store with no such code shows nothing");
  let html = await form();
  is("no field", [html.includes('name="rcode"'), html.includes('id="returning"')], [false, false]);

  part("A store with an ended code shows nothing");
  await setReturningCodes(OWNER, [{ code: "OLDTHANKS", coupon: "cpn_ReturnBoxOld01", off: { kind: "percent", percent: 10 }, endsAt: 1_000_000_000, createdAt: 999_000_000 }]);
  html = await form();
  is("no field", html.includes('name="rcode"'), false);

  part("A store with a code still running");
  await setReturningCodes(OWNER, [{ code: "THANKYOU", coupon: "cpn_ReturnBox0001", off: { kind: "percent", percent: 20 }, endsAt: null, createdAt: 1_790_000_000 }]);
  html = await form();
  const buy = html.slice(html.indexOf('action="/api/store/checkout"'));
  const box = html.slice(html.indexOf('<details id="returning"'), html.indexOf("</details>", html.indexOf('<details id="returning"')) + 10);
  is("the field is inside the form that opens the checkout", [buy.includes('name="rcode"'), buy.includes('name="remail"')], [true, true]);
  is("closed, and its line says what it is", [/<details id="returning"[^>]*\bopen\b/.test(box), box.includes("Bought here before? Use your code")], [false, true]);
  is("both boxes start empty", [/name="rcode"[^>]*value="[^"]+"/.test(box), /name="remail"[^>]*value="[^"]+"/.test(box)], [false, false]);
  const codeId = /<input id="([^"]+)"[^>]*name="rcode"/.exec(box)?.[1] ?? "";
  is("the code box has a visible label tied to it", box.includes(`<label for="${codeId}" class="st-label">Your code</label>`), true);
  is("and its note, which says how the code is checked", new RegExp(`<input id="${codeId}"[^>]*aria-describedby="${codeId.replace("-code", "-note")}"`).test(box), true);
  is("the email box has a visible label tied to it", box.includes(`<label for="${codeId.replace("-code", "-email")}" class="st-label">The email of your earlier order</label>`), true);
  is("the email box says what is done with it, and for how long it is kept", box.includes("it gets a link that works once, for 30 minutes. We keep it only for those 30 minutes."), true);
  const ask = /<button[^>]*>Email me the link<\/button>/.exec(box)?.[0] ?? "";
  is("asking for the link is its own button, which the buying boxes do not hold back", [/type="submit"/.test(ask), /formNoValidate=""/.test(ask)], [true, true]);
  is("it alone asks for the link (rask), and is not counted as a checkout started", [/name="rask"/.test(ask), /value="1"/.test(ask), /data-no-checkout=""/.test(ask)], [true, true, true]);
  is("no link in the address: no hidden link field", box.includes('name="rtoken"'), false);
  is("no reason is said before anything was tried", box.includes('role="alert"'), false);

  part("Only in the product page's own buy box");
  {
    const store = (await storeForEmail(OWNER))!;
    const product = (await readListing(store, made.product.id))!;
    const draw = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(BuyBox, { store, product, related: [], remaining: null, writes: true, selling: true, ...extra } as Parameters<typeof BuyBox>[0]));
    is("not in an exit offer's box, a store card's, or the embedded checkout", [draw({ place: "x-" }).includes('name="rcode"'), draw({ stepped: true }).includes('name="rcode"'), draw({ embed: { site: "https://example.com", back: "" } }).includes('name="rcode"')], [false, false, false]);
  }
  is("PayPal from the same form refuses a code it cannot take", /withCode\) return away\(`\/@\$\{store\.handle\}\/p\/\$\{product\.id\}\?returning=other#returning`\)/.test(readFileSync("app/api/store/paypal/checkout/route.ts", "utf8")), true);
  is("the pixels and the page's depth leave the link button out", [readFileSync("components/store-pixels.tsx", "utf8").includes('e.submitter.hasAttribute("data-no-checkout")'), readFileSync("components/page-depth.tsx", "utf8").includes(":not([data-no-checkout])")], [true, true]);

  part("Not where the buyer names the price");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const pwyw = renderToStaticMarkup(createElement(BuyBox, { store, product: { ...product, pwyw: { minCents: 500, suggestedCents: 1000 } } as typeof product, related: [], remaining: null, writes: true, selling: true }));
  is("no field", pwyw.includes('name="rcode"'), false);

  part("Every sentence in each language a store can speak");
  is("all seven languages", Object.keys(RETURNING_CODE_WORDS).sort(), [...LANGUAGE_CODES].sort());
  for (const lang of LANGUAGE_CODES) {
    const w = RETURNING_CODE_WORDS[lang];
    const all = [w.open, w.note, w.codeLabel, w.emailLabel, w.emailNote, w.send, w.sent, w.confirmed, ...RETURNING_REFUSALS.map((r) => w.refused[r])];
    is(`${lang}: nothing empty, a sentence for each reason`, all.every((line) => typeof line === "string" && line.trim().length > 0), true);
    if (lang !== "en") {
      const en = RETURNING_CODE_WORDS.en;
      is(`${lang}: not left in English`, all.some((line, i) => line === [en.open, en.note, en.codeLabel, en.emailLabel, en.emailNote, en.send, en.sent, en.confirmed, ...RETURNING_REFUSALS.map((r) => en.refused[r])][i]), false);
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
