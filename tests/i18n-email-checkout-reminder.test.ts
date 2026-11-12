/**
 * The checkout reminder (lib/checkout-recovery.ts remindAbandoned), for one
 * product and for a cart, in every buyer language, from a store whose name
 * and product titles are edge data (< > & " ', a right-to-left name, emoji),
 * in a currency with cents (USD) and one without (JPY):
 *
 *   - nothing unwritten: no "undefined", "NaN", "null", "[object Object]",
 *     "Infinity", "${" or a template's ⟦placeholder⟧;
 *   - the store's name and the titles as typed (plain text, never escaped);
 *   - the price as the store's language writes it, the amount unchanged
 *     (lib/money.ts formatMoney with the language's locale);
 *   - the creator's name and postal address, the stop link to a page that
 *     reads its token, and the one-click List-Unsubscribe headers to the door
 *     that honours it (AGENTS.md, "Checkout reminder (function 3)").
 *
 * Synthetic stores and buyers; Stripe and the sender are stand-ins.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setCurrency, setLanguage, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readStopToken, remindAbandoned } from "@/lib/checkout-recovery";
import { formatMoney } from "@/lib/money";
import { LANGUAGES, LANGUAGE_CODES } from "@/lib/store-language";
import { SITE_URL } from "@/lib/site-url";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_i18n_reminder_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

type Mail = { to: string; subject: string; text: string; html?: string; headers?: Record<string, string> };
const emails: Mail[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as Mail & { to: string | string[] };
    emails.push({ ...body, to: [body.to].flat()[0] });
    return answer({ id: `email_${emails.length}` });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${url.pathname}` } }, 404);
}) as typeof fetch;

const BAD = /\bundefined\b|\bNaN\b|\bnull\b|\[object Object\]|\bInfinity\b|⟦|\$\{/;
const ADDRESS = "9 Kiln Road, Portland, OR 97201";
const STORES = [
  { owner: "i18n-rem-usd@example.test", handle: "i18nremusd", name: `Tom & Jerry's <b>"Shop"</b>`, currency: "usd" as const, prices: ["24.50", "9.99"] },
  { owner: "i18n-rem-jpy@example.test", handle: "i18nremjpy", name: "متجر الكتب 🎨", currency: "jpy" as const, prices: ["2400", "1000"] },
];
const TITLES = [`Glaze <Recipes> & "Tips"`, `Café ✨ ${"Long ".repeat(20).trim()}`];

async function main(): Promise<void> {
  redis.clear();
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  for (const shop of STORES) {
    part(`${shop.currency}: ${shop.name}`);
    await claimHandle(shop.owner, shop.handle, shop.name, "");
    await ensureStatsId(shop.owner);
    await ensureListId(shop.owner);
    is(`${shop.currency}: currency set`, (await setCurrency(shop.owner, shop.currency)).ok, true);
    await setStripeAccount(shop.owner, `acct_1TestI18n${shop.currency}0001`, true);
    await setSubscription(shop.owner, { customerId: `cus_I18n${shop.currency}01`, subscriptionId: `sub_I18n${shop.currency}01`, active: true, period: paidPeriod() });
    await setRecovery(shop.owner, { enabled: true, address: ADDRESS, asks: true });
    const ids: string[] = [];
    for (const [i, title] of TITLES.entries()) {
      const made = await addProduct(shop.owner, title, "", shop.prices[i], null);
      if (!made.ok) throw new Error(`no product: ${JSON.stringify(made)}`);
      await setProductLink(shop.owner, made.product.id, `https://example.com/${made.product.id}`);
      ids.push(made.product.id);
    }
    for (const language of LANGUAGE_CODES) {
      await setLanguage(shop.owner, language);
      const store = (await storeForEmail(shop.owner))!;
      const locale = LANGUAGES[language].locale;
      for (const cart of [false, true]) {
        n += 1;
        const email = `buyer${n}@example.test`;
        const session = {
          id: `cs_test_i18n${String(n).padStart(10, "0")}`,
          object: "checkout.session",
          status: "expired",
          payment_status: "unpaid",
          created: now - 3700,
          expires_at: now - 100,
          consent: { promotions: "opt_in" },
          customer_details: { email },
          metadata: cart ? { store: shop.handle, product: ids[0], cart: "yes", bump: ids[1] } : { store: shop.handle, product: ids[0] },
        } as never;
        const where = `${language} ${shop.currency} ${cart ? "cart" : "product"}`;
        is(`${where}: sent`, await remindAbandoned(store, session), "sent");
        const mail = emails.at(-1)!;
        is(`${where}: to the buyer`, mail.to, email);
        is(`${where}: nothing unwritten`, [BAD.test(mail.subject), BAD.test(mail.text)], [false, false]);
        is(`${where}: names as typed, never escaped`, [mail.text.includes(shop.name), mail.text.includes(TITLES[0]), /&(amp|lt|gt|quot|#39);/.test(mail.text + mail.subject)], [true, true, false]);
        is(`${where}: the price as the language writes it`, mail.text.includes(formatMoney(shop.currency === "jpy" ? 2400 : 2450, store.currency, locale)), true);
        if (cart) is(`${where}: the second item's price too`, mail.text.includes(formatMoney(shop.currency === "jpy" ? 1000 : 999, store.currency, locale)), true);
        is(`${where}: the creator's name and postal address`, mail.text.includes(`${shop.name} · ${ADDRESS}`), true);
        const token = /\/unsubscribe\?r=([0-9a-f]{40})/.exec(mail.text)?.[1] ?? "";
        is(`${where}: a stop link whose token the page reads`, (await readStopToken(token))?.email, email);
        is(`${where}: one-click headers to the door`, [mail.headers?.["List-Unsubscribe"], mail.headers?.["List-Unsubscribe-Post"]], [`<${SITE_URL}/api/mail/unsubscribe?r=${token}>`, "List-Unsubscribe=One-Click"]);
        is(`${where}: a subject that fits`, mail.subject.length > 0 && mail.subject.length <= 200, true);
      }
    }
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
