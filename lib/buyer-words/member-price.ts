/**
 * A member price on a product's page (components/member-price.tsx, 620
 * [SZ4]), in each language a store can speak: what a proved member is shown
 * beside the buy box, and the two answers the checkout sends back
 * (app/api/store/checkout/route.ts, ?member=changed and ?member=alone).
 *
 * Browser-safe: plain data, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type MemberPriceWords = {
  /** The name, before the amount: "Member price". */
  head: string;
  /** "Member price $21.60 (regular $27)": both amounts said in words, never by color alone. */
  line: (member: string, regular: string) => string;
  /** Who it is for: what the checkout takes it on. */
  note: string;
  /** Beside a PayPal button, which takes no member price off (lib/paypal-sales.ts). */
  paypal: string;
  /** The checkout could not prove the price shown: nothing was charged, the page shows the price now. */
  changed: string;
  /** A member price was asked with a gift, places, a plan, a checked box or a pre-order: nothing was charged. */
  alone: string;
};

const en: MemberPriceWords = {
  head: "Member price",
  line: (member, regular) => `Member price ${member} (regular ${regular})`,
  note: "For your own purchase of this product, paid in full by card.",
  paypal: "If you pay with PayPal, the member price does not apply.",
  changed: "We could not confirm your member price, so nothing was charged. The price on this page is your price now.",
  alone: "The member price is only for buying this product for yourself, on its own, paid in full. Nothing was charged.",
};
const es: MemberPriceWords = {
  head: "Precio de miembro",
  line: (member, regular) => `Precio de miembro ${member} (normal ${regular})`,
  note: "Para tu propia compra de este producto, pagada entera con tarjeta.",
  paypal: "Si pagas con PayPal, el precio de miembro no se aplica.",
  changed: "No pudimos confirmar tu precio de miembro, así que no se cobró nada. El precio de esta página es tu precio ahora.",
  alone: "El precio de miembro es solo para comprar este producto para ti, solo, pagado entero. No se cobró nada.",
};
const fr: MemberPriceWords = {
  head: "Prix membre",
  line: (member, regular) => `Prix membre ${member} (prix normal ${regular})`,
  note: "Pour votre propre achat de ce produit, payé en une fois par carte.",
  paypal: "Si vous payez avec PayPal, le prix membre ne s’applique pas.",
  changed: "Nous n’avons pas pu confirmer votre prix membre, donc rien n’a été débité. Le prix sur cette page est votre prix maintenant.",
  alone: "Le prix membre vaut seulement pour acheter ce produit pour vous, seul, payé en une fois. Rien n’a été débité.",
};
const de: MemberPriceWords = {
  head: "Mitgliederpreis",
  line: (member, regular) => `Mitgliederpreis ${member} (regulär ${regular})`,
  note: "Für Ihren eigenen Kauf dieses Produkts, vollständig per Karte bezahlt.",
  paypal: "Wenn Sie mit PayPal zahlen, gilt der Mitgliederpreis nicht.",
  changed: "Wir konnten Ihren Mitgliederpreis nicht bestätigen, daher wurde nichts berechnet. Der Preis auf dieser Seite ist jetzt Ihr Preis.",
  alone: "Der Mitgliederpreis gilt nur, wenn Sie dieses Produkt für sich selbst kaufen, allein und vollständig bezahlt. Es wurde nichts berechnet.",
};
const it: MemberPriceWords = {
  head: "Prezzo membri",
  line: (member, regular) => `Prezzo membri ${member} (normale ${regular})`,
  note: "Per il tuo acquisto di questo prodotto, pagato per intero con carta.",
  paypal: "Se paghi con PayPal, il prezzo membri non si applica.",
  changed: "Non abbiamo potuto confermare il tuo prezzo membri, quindi non è stato addebitato nulla. Il prezzo su questa pagina è il tuo prezzo ora.",
  alone: "Il prezzo membri vale solo se compri questo prodotto per te, da solo, pagato per intero. Non è stato addebitato nulla.",
};
const nl: MemberPriceWords = {
  head: "Ledenprijs",
  line: (member, regular) => `Ledenprijs ${member} (normaal ${regular})`,
  note: "Voor je eigen aankoop van dit product, in één keer betaald met een kaart.",
  paypal: "Als je met PayPal betaalt, geldt de ledenprijs niet.",
  changed: "We konden je ledenprijs niet bevestigen, dus er is niets afgeschreven. De prijs op deze pagina is nu jouw prijs.",
  alone: "De ledenprijs geldt alleen als je dit product voor jezelf koopt, los en in één keer betaald. Er is niets afgeschreven.",
};
const pt: MemberPriceWords = {
  head: "Preço de membro",
  line: (member, regular) => `Preço de membro ${member} (normal ${regular})`,
  note: "Para a sua própria compra deste produto, paga por inteiro com cartão.",
  paypal: "Se pagar com o PayPal, o preço de membro não se aplica.",
  changed: "Não foi possível confirmar o seu preço de membro, por isso nada foi cobrado. O preço nesta página é o seu preço agora.",
  alone: "O preço de membro é só para comprar este produto para si, sozinho, pago por inteiro. Nada foi cobrado.",
};

export const MEMBER_PRICE_WORDS: Record<LanguageCode, MemberPriceWords> = { en, es, fr, de, it, nl, pt };

export function memberPriceWords(language: unknown): MemberPriceWords {
  return MEMBER_PRICE_WORDS[parseLanguage(language)];
}
