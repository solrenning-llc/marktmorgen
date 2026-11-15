/**
 * 366 [EZ3]: when a creator publishes a paid product, a launch email waits for
 * them as a draft in the studio's email page (lib/mail-drafts.ts), so telling
 * their list is one read and one press away. Built from the product's own
 * public words only (its title, its summary, its published price, its
 * address), with nothing generated and nothing added: no discount, urgency or
 * count. For everyone on the list who has not bought it (the existing audience
 * "everyone, not those who got this product").
 *
 * Never sent on its own: a draft only ever reaches the list when the owner or
 * an Admin sends it. Once per product on a list:
 *
 *   nl:launch:<listId>:<productId>   a draft was kept for it, 400 days
 *
 * so publishing again, a retry or a second tab never makes a second one. A
 * store already holding its twenty drafts gets none, and nothing of theirs is
 * replaced; the mark is let go, so a later publish can try again.
 */
import { redisPipeline } from "@/lib/redis";
import { saveDraft } from "@/lib/mail-drafts";
import { pricePill } from "@/lib/product-pill";
import type { Store } from "@/lib/store";
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const KEEP_SECONDS = 400 * 86_400;
/** Who the studio shows saved it: not a person. */
export const LAUNCH_BY = "launch-draft";

type Launched = Parameters<typeof pricePill>[1];

export const launchMark = (listId: string, productId: string) => `nl:launch:${listId}:${productId}`;

/** The few fixed words around the product's own, in the store's language: the creator reads and may change them. */
const WORDS: Record<LanguageCode, { subject: (store: string, title: string) => string; lead: (title: string) => string; price: string }> = {
  en: { subject: (store, title) => `New from ${store}: ${title}`, lead: (title) => `${title} is now in my store.`, price: "Price" },
  es: { subject: (store, title) => `Nuevo en ${store}: ${title}`, lead: (title) => `${title} ya está en mi tienda.`, price: "Precio" },
  fr: { subject: (store, title) => `Nouveau chez ${store} : ${title}`, lead: (title) => `${title} est maintenant dans ma boutique.`, price: "Prix" },
  de: { subject: (store, title) => `Neu bei ${store}: ${title}`, lead: (title) => `${title} ist jetzt in meinem Shop.`, price: "Preis" },
  it: { subject: (store, title) => `Novità da ${store}: ${title}`, lead: (title) => `${title} è ora nel mio negozio.`, price: "Prezzo" },
  nl: { subject: (store, title) => `Nieuw bij ${store}: ${title}`, lead: (title) => `${title} staat nu in mijn winkel.`, price: "Prijs" },
  pt: { subject: (store, title) => `Novidade de ${store}: ${title}`, lead: (title) => `${title} já está na minha loja.`, price: "Preço" },
};

/** The draft's words, from the product's own public facts only, in the store's language. */
export function launchDraftText(store: Store, product: Launched, link: string): { subject: string; body: string } {
  const w = WORDS[parseLanguage(store.language)];
  const summary = typeof product.summary === "string" ? product.summary.trim() : "";
  return {
    subject: w.subject(store.name, product.title),
    body: [w.lead(product.title), ...(summary ? ["", summary] : []), "", `${w.price}: ${pricePill(store, product)}`, "", link].join("\n"),
  };
}

export type LaunchOutcome = "saved" | "already" | "skipped" | "full" | "unknown";

/** Keeps the launch draft for a product just made public; never sends anything. */
export async function keepLaunchDraft(store: Store, product: Launched, link: string): Promise<LaunchOutcome> {
  if (!store.listId || product.hidden === true || !(product.priceCents > 0)) return "skipped";
  const key = launchMark(store.listId, product.id);
  const claim = await redisPipeline([["SET", key, "1", "NX", "EX", KEEP_SECONDS]]);
  // Only an exact reply decides: an unconfirmed claim is never taken as a free one.
  if (!Array.isArray(claim) || claim.length !== 1 || !Object.hasOwn(claim, 0) || (claim[0] !== "OK" && claim[0] !== null)) throw new Error("Launch draft claim could not be confirmed");
  if (claim[0] === null) return "already";
  const words = launchDraftText(store, product, link);
  let outcome: LaunchOutcome = "unknown";
  try {
    const saved = await saveDraft(store, LAUNCH_BY, { subject: words.subject, body: words.body, productId: "", audience: { who: "all", notProductId: product.id, narrow: null } });
    outcome = saved.ok ? "saved" : saved.reason === "full" ? "full" : "unknown";
  } finally {
    if (outcome !== "saved") await redisPipeline([["DEL", key]]).catch(() => {});
  }
  return outcome;
}
