import { joinWords } from "@/lib/buyer-words/join";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { claimHandle, ensureListId, ensureStatsId, setJoin, setLanguage, setSubscription, storeForEmail } from "@/lib/store";
import { askToJoin, confirmJoin, readJoinToken } from "@/lib/store-join";
import { leadsKey, parseContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const NOTES: Record<LanguageCode, string> = {
  en: "You join the email list only after you confirm with the button.",
  es: "Solo te unes a la lista de email después de confirmar con el botón.",
  fr: "Vous rejoignez la liste d'e-mails uniquement après avoir confirmé avec le bouton.",
  de: "Du wirst erst in die E-Mail-Liste aufgenommen, wenn du mit dem Button bestätigst.",
  it: "Entri nella lista email solo dopo aver confermato con il pulsante.",
  nl: "Je komt pas op de e-maillijst nadat je met de knop hebt bevestigd.",
  pt: "Só entra na lista de emails depois de confirmar com o botão.",
};

const messages: { text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.resend.com") throw new Error(`Unexpected provider: ${url.hostname}`);
  messages.push(JSON.parse(String(init?.body)) as { text: string });
  return new Response(JSON.stringify({ id: "email_confirmation_copy_test" }));
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

  part("The note describes enrollment, while the confirmation keeps a pending address");
  for (const [index, code] of LANGUAGE_CODES.entries()) {
    await setLanguage(owner, code);
    const store = (await storeForEmail(owner))!;
    const email = `buyer-${code}@example.com`;
    is(`${code}: note states enrollment after the confirmation button`, joinWords(code).sentNote, NOTES[code]);
    is(`${code}: real request sends a confirmation`, await askToJoin({ store, email, ip: `192.0.2.${index + 1}`, origin: "https://example.com" }), "sent");
    const token = messages.at(-1)?.text.match(/join\?token=([0-9a-f]{48})/)?.[1] ?? "";
    is(`${code}: a pending address exists before confirmation`, (await readJoinToken(token))?.e, email);
    const contact = () => parseContact(redis.run(["HGET", leadsKey(store.listId!), email]));
    is(`${code}: that pending address is not on the email list`, contact(), null);
    is(`${code}: the confirmation button enrolls it`, (await confirmJoin(token, store)).ok, true);
    is(`${code}: the resulting contact has confirmed consent`, contact()?.agreed, true);
  }
  is("one confirmation per language, with no additional email", messages.length, LANGUAGE_CODES.length);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
