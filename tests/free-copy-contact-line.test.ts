/**
 * 755 [STN2], unit 1: the free copy's email says how to write to the creator.
 * Replies to it do not reach the store (it is sent from Marktmorgen, and the
 * creator's own address is never handed to whoever typed an address), so
 * when the store page's contact form is open (lib/store-contact.ts,
 * contactOpen) the email names it, with its link, in the store's language.
 * When the form is closed the email says nothing about it, never a link to a
 * form that is not there. The email stays plain text: no image, no pixel,
 * no link but the copy's and the form's. Synthetic store and provider only.
 */
import { givingWords } from "@/lib/buyer-words/giving";
import { requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { addProduct, claimHandle, ensureStatsId, setContact, setLanguage, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const sent: { text?: string; html?: string; reply_to?: unknown }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.resend.com") throw new Error(`Unexpected provider: ${url.hostname}`);
  sent.push(JSON.parse(String(init?.body ?? "{}")));
  return Response.json({ id: `email_free_contact_${sent.length}` });
}) as typeof fetch;

/** The words for the contact line, or "(none)" where the language has none. */
const contactWords = (code: (typeof LANGUAGE_CODES)[number], store: string, link: string): string =>
  (givingWords(code) as unknown as { freeContact?: (store: string, link: string) => string }).freeContact?.(store, link) ?? "(none)";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";
  const owner = "owner@example.com";
  await claimHandle(owner, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_FreeContact01", subscriptionId: "sub_FreeContact01", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Pantry Guide", "", "0", null);
  if (!made.ok) throw new Error("Synthetic free product was refused");
  await setProductLink(owner, made.product.id, "https://example.com/pantry-guide.pdf");
  const link = "https://example.com/@harbor#contact";
  let n = 0;
  const ask = async () => {
    const store = (await storeForEmail(owner))!;
    const product = (await readListing(store, made.product.id))!;
    n += 1;
    const result = await requestCopy({ store, product, email: `buyer-${n}@example.com`, consent: false, ip: `192.0.2.${n}`, origin: "https://example.com" });
    return { result, mail: sent[sent.length - 1] ?? {} };
  };

  part("The contact form is open: the email says how to write to the creator");
  await setContact(owner, { on: true, heading: "Write to us", line: "" });
  for (const code of LANGUAGE_CODES) {
    await setLanguage(owner, code);
    const { result, mail } = await ask();
    const words = contactWords(code, "Harbor Kitchen", link);
    is(`${code}: the copy is sent`, result, "sent");
    is(`${code}: the line has the store, the form's link, and no unresolved words`, [words.includes("Harbor Kitchen"), words.includes(link), /undefined|NaN|\$\{|\[object/.test(words)], [true, true, false]);
    is(`${code}: the email carries that line`, (mail.text ?? "").includes(words), true);
    is(`${code}: still plain text, with no reply address handed out`, [mail.html === undefined, mail.reply_to === undefined], [true, true]);
  }

  part("The contact form is closed: no line, no link to it");
  await setContact(owner, { on: false, heading: "", line: "" });
  await setLanguage(owner, "en");
  const { result, mail } = await ask();
  is("the copy is sent", result, "sent");
  is("no link to a form that is not there", (mail.text ?? "").includes("#contact"), false);
  is("the footer still says replies do not reach the store", (mail.text ?? "").includes(givingWords("en").freeSentBy("Harbor Kitchen")), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
