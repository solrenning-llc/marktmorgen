import { joinWords } from "@/lib/buyer-words/join";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { askToJoin } from "@/lib/store-join";
import { claimHandle, ensureListId, ensureStatsId, setJoin, setLanguage, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, string> = {
  en: "We emailed you a button to confirm you want emails from Harbor Kitchen. If it is not there, look in spam.",
  es: "Te enviamos un botón para confirmar que quieres recibir emails de Harbor Kitchen. Si no está, mira en spam.",
  fr: "Nous vous avons envoyé un bouton pour confirmer que vous voulez recevoir les e-mails de Harbor Kitchen. S'il n'est pas là, regardez dans les spams.",
  de: "Wir haben dir einen Button geschickt, mit dem du bestätigst, dass du E-Mails von Harbor Kitchen möchtest. Falls nicht, sieh im Spam nach.",
  it: "Ti abbiamo inviato un pulsante per confermare che vuoi ricevere le email di Harbor Kitchen. Se non c'è, guarda nello spam.",
  nl: "We hebben je een knop gestuurd om te bevestigen dat je e-mails van Harbor Kitchen wilt. Staat hij er niet, kijk dan bij spam.",
  pt: "Enviámos-lhe um botão para confirmar que quer receber emails de Harbor Kitchen. Se não estiver lá, veja no spam.",
};

const requests: { method: string; url: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  requests.push({ method: init?.method ?? "GET", url });
  if (new URL(url).hostname !== "api.resend.com") throw new Error(`Unexpected provider: ${url}`);
  return new Response(JSON.stringify({ id: "email_join_delivery_copy" }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_join_only";
  const owner = "owner@example.com";
  await claimHandle(owner, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  await setJoin(owner, { on: true });

  part("A join request knows provider acceptance, not inbox delivery time");
  for (const [index, code] of LANGUAGE_CODES.entries()) {
    await setLanguage(owner, code);
    const store = (await storeForEmail(owner))!;
    is(`${code}: the real request reports provider acceptance`, await askToJoin({ store, email: `buyer-${code}@example.com`, ip: `192.0.2.${index + 1}`, origin: "https://example.com" }), "sent");
    const text = joinWords(code).sentBody(store.name);
    is(`${code}: renders the complete status without an inbox deadline`, text, EXPECTED[code]);
    is(`${code}: keeps the store and spam guidance`, [text.includes(store.name), /spam/i.test(text)], [true, true]);
    is(`${code}: has no unresolved interpolation`, /undefined|NaN|\$\{|\[object/.test(text), false);
  }
  is("one provider request was accepted for each language", requests.length, LANGUAGE_CODES.length);
  is("the flow makes no delivery-status read", requests.some(({ method }) => method === "GET"), false);
  is("all provider requests use the email endpoint", requests.every(({ method, url }) => method === "POST" && url === "https://api.resend.com/emails"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
