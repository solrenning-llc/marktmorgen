import { givingWords } from "@/lib/buyer-words/giving";
import { requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  setLanguage,
  setProductLink,
  setSubscription,
  storeForEmail,
} from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const EXPECTED: Record<LanguageCode, string> = {
  en: "It comes from Harbor Kitchen via Marktmorgen. If it is not there, look in spam.",
  es: "Llega de Harbor Kitchen a través de Marktmorgen. Si no está, mira en spam.",
  fr: "Il vient de Harbor Kitchen via Marktmorgen. S'il n'y est pas, regardez dans les spams.",
  de: "Er kommt von Harbor Kitchen über Marktmorgen. Falls nicht, sehen Sie im Spam-Ordner nach.",
  it: "Arriva da Harbor Kitchen tramite Marktmorgen. Se non lo trovi, guarda nello spam.",
  nl: "De e-mail komt van Harbor Kitchen via Marktmorgen. Staat hij er niet, kijk dan in je spam.",
  pt: "Chega de Harbor Kitchen através da Marktmorgen. Se não estiver lá, veja na pasta de spam.",
};

const providerCalls: { method: string; pathname: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.resend.com") throw new Error(`Unexpected provider: ${url.hostname}`);
  providerCalls.push({ method: init?.method ?? "GET", pathname: url.pathname });
  return Response.json({ id: `email_free_copy_${providerCalls.length}` });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";
  const owner = "owner@example.com";
  await claimHandle(owner, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await setSubscription(owner, {
    customerId: "cus_FreeCopyDelivery01",
    subscriptionId: "sub_FreeCopyDelivery01",
    active: true,
    period: paidPeriod(),
  });
  const made = await addProduct(owner, "Pantry Guide", "", "0", null);
  if (!made.ok) throw new Error("Synthetic free product was refused");
  await setProductLink(owner, made.product.id, "https://example.com/pantry-guide.pdf");

  part("A free-copy request knows provider acceptance, not inbox delivery time");
  for (const [index, code] of LANGUAGE_CODES.entries()) {
    await setLanguage(owner, code);
    const store = (await storeForEmail(owner))!;
    const product = (await readListing(store, made.product.id))!;
    is(
      `${code}: the real request reports provider acceptance`,
      await requestCopy({
        store,
        product,
        email: `buyer-${code}@example.com`,
        consent: false,
        ip: `192.0.2.${index + 1}`,
        origin: "https://example.com",
      }),
      "sent",
    );
    const text = givingWords(code).comesFrom(store.name);
    is(`${code}: renders the complete status without an inbox deadline`, text, EXPECTED[code]);
    is(`${code}: keeps the store and spam guidance`, [text.includes(store.name), /spam/i.test(text)], [true, true]);
    is(`${code}: has no unresolved interpolation`, /undefined|NaN|\$\{|\[object/.test(text), false);
  }
  is("one provider request was accepted for each language", providerCalls.length, LANGUAGE_CODES.length);
  is("the flow makes no delivery-status read", providerCalls.every((call) => call.method === "POST"), true);
  is("all provider requests use the email endpoint", providerCalls.every((call) => call.pathname === "/emails"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
