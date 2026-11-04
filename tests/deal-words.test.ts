/**
 * The words of a deal or of pressure that a reply of the store assistant,
 * its next product after a purchase and its checkout reminder may use only
 * when the store's own text does (DEAL_WORDS, heldToFacts in
 * lib/store-assistant-rules.ts): singular and plural, in every language a
 * store can speak, whole words only (edge tests of 4 November 2026: plurals
 * such as "discounts" and "five stars" passed).
 */
import { DEAL_WORDS, heldToFacts } from "@/lib/store-assistant-rules";
import { neutralLine } from "@/lib/assistant-reminder-rules";
import { done, is, part } from "./check";

const caught = (words: string[]) => words.filter((w) => !DEAL_WORDS.test(`Here: ${w}, today.`));

part("Plurals and forms in English");
is("every one is caught", caught(["discounts", "discounted", "coupons", "promos", "promo codes", "vouchers", "codes", "sale prices", "testimonials", "five stars", "5-stars", "five-star", "bestsellers", "best sellers", "exclusive offers", "limited-time", "50% off", "50 % off"]), []);

part("Each language a store speaks, singular and plural");
is("Spanish", caught(["descuento", "descuentos", "cupón", "cupones", "código promocional", "códigos promocionales", "rebajas", "oferta limitada", "última oportunidad", "testimonios", "cinco estrellas", "más vendidos"]), []);
is("French", caught(["réduction", "réductions", "remises", "code promo", "codes promo", "offre limitée", "dernière chance", "dépêchez-vous", "témoignages", "cinq étoiles", "meilleures ventes"]), []);
is("German", caught(["Rabatt", "Rabatte", "Gutschein", "Gutscheine", "Rabattcode", "Sonderangebote", "letzte Chance", "nur heute", "Kundenstimmen", "fünf Sterne"]), []);
is("Italian", caught(["sconto", "sconti", "codice promozionale", "codici promozionali", "offerta limitata", "ultima occasione", "affrettati", "testimonianze", "cinque stelle", "più venduti"]), []);
is("Dutch", caught(["korting", "kortingen", "kortingscode", "kortingscodes", "tijdelijke aanbieding", "laatste kans", "alleen vandaag", "vijf sterren"]), []);
is("Portuguese", caught(["desconto", "descontos", "cupom", "cupons", "cupão", "cupões", "código promocional", "códigos promocionais", "última oportunidade", "só hoje", "depoimentos", "cinco estrelas", "mais vendidos"]), []);

part("Compounds, spacing and typography");
is("German and Dutch compounds that end in the deal word", caught(["Frühlingsrabatt", "Mengenrabatt", "Sommergutschein", "prijskorting"]), []);
is("free shipping in each language", caught(["envío gratis", "livraison gratuite", "kostenloser Versand", "spedizione gratuita", "gratis verzending", "frete grátis", "scontati"]), []);
is("however the words are spaced or joined", caught(["last  chance", "last\nchance", "last\u00a0chance", "limited\u2011time", "aujourd’hui seulement", "best sellers", "bestseller", "best-seller", "SÓLO HOY"]), []);
is("the store's own word is found however either side was typed", heldToFacts("Last  chance to join.", "The last chance to join is Friday."), true);

part("Whole words only: an ordinary word that merely contains one is not caught");
is("none of these", ["A barcode scanner", "The Codex class", "We promote our classes", "A promoter", "Encoded lessons", "Ultimatum", "Sconfitta e rinascita", "Ein Scontrino", "Postversand in 3 Tagen", "Salesforce training", "Sold out", "Promouvoir vos cours"].filter((t) => DEAL_WORDS.test(t)), []);

part("Held to the facts: a plural the store never wrote is not shown");
const facts = "Pottery course. 12 lessons. $27.";
is("plural deal words in a reply are refused", [heldToFacts("Many coupons are available.", facts), heldToFacts("It has five stars from buyers.", facts), heldToFacts("Hay descuentos hoy.", facts), heldToFacts("Profitez des réductions.", facts)], [false, false, false, false]);
is("but a word the store wrote is allowed", heldToFacts("Testimonials are on the page.", `${facts} Testimonials from our students.`), true);
is("and an ordinary reply passes", heldToFacts("It has 12 lessons for $27.", facts), true);
is("the reminder's sentence too", neutralLine("Grab the coupons before they go.", facts), "");
part("Third review: the reply is read in one form, hidden marks removed, and the store's word as a whole word");
is("a decomposed accent or a hidden mark inside the word is still the word", [heldToFacts("cupo\u0301n", "nada"), heldToFacts("dis\u200bcount", "nothing"), heldToFacts("Ra\u00ADbatt", "nichts")], [false, false, false]);
is("a word the store wrote only inside a longer one does not allow it alone", [heldToFacts("A discount today.", "A discounted item."), heldToFacts("Rabatt heute.", "Frühlingsrabatt im Mai.")], [false, false]);
is("but the same word as the store wrote it is allowed", heldToFacts("A discount for members.", "Members get a discount."), true);
is("dépêchez vous with a space too", caught(["dépêchez vous"]), []);
is("a discount the store wrote as a figure and '% off' may be repeated", heldToFacts("It is 20% off today.", "Members get 20% off."), true);
is("an invisible operator inside a word is removed too", heldToFacts("dis\u2063count", "nothing"), false);

part("Fourth review (4 November 2026): a word hidden by Unicode is refused, whatever the facts say");
const probe = "The Course costs $20. It has 20 lessons. Discounts for teams. Cupón de bienvenida.";
const hidden = [
  "Ask for a dis\u0441ount.", // Cyrillic es
  "Ask for a \uFF44\uFF49\uFF53\uFF43\uFF4F\uFF55\uFF4E\uFF54.", // fullwidth
  "Ask for a \u{1D41D}\u{1D422}\u{1D42C}\u{1D41C}\u{1D428}\u{1D42E}\u{1D427}\u{1D42D}.", // mathematical bold
  "Ask for a dis\u200Ecount.", // left-to-right mark
  "Ask for a dis\uFE0Fcount.", // variation selector
  "Ask for a dis\u{E0020}count.", // tag space
  "Ask for a dis\u2066count.", // isolate
  "Ask for a di\u0301scount.", // combining accent
  "Ask for a díscount.", // precomposed accent
  "Ask for a D\u0130SCOUNT.", // Turkish dotted capital I
  "Ask for a d\u0131scount.", // Turkish dotless i
  "Ask for a dis.count.", "Ask for a dis-count.", "Ask for a dis_count.", "Ask for a dis\u00B7count.",
];
is("each hidden form is refused", hidden.filter((reply) => heldToFacts(reply, probe)), []);
is("a word mixing scripts is refused even with no deal in it", heldToFacts("The \u0441ourse has 20 lessons.", probe), false);
is("hidden with no deal in the facts too", [heldToFacts("A dis\u0441ount.", "nothing"), heldToFacts("dis.count", "nothing"), heldToFacts("\uFF52\uFF41\uFF42\uFF41\uFF54\uFF54", "nichts")], [false, false, false]);
is("a number in another script is compared as its ASCII digits", [
  heldToFacts("It costs $\uFF12\uFF10.", probe), heldToFacts("It costs $\u0662\u0660.", probe),
  heldToFacts("It costs $\uFF13\uFF10.", probe), heldToFacts("It costs $\u0663\u0660.", probe), heldToFacts("Only \u09E9\u09E6 lessons.", probe),
  heldToFacts("It costs $2\u200B0.", probe), heldToFacts("Only 2² left.", "Only 2 left."),
], [true, true, false, false, false, true, false]);
is("a link in fullwidth letters is refused", heldToFacts("See \uFF57\uFF57\uFF57\uFF0Eexample\uFF0Ecom", probe), false);
is("the reply shown is never changed by the folding", (() => { const text = "Ask about the Cupón."; heldToFacts(text, probe); return text; })(), "Ask about the Cupón.");

part("Fourth review: forms that were missed");
is("English", caught(["bestselling", "best-selling", "promotion", "promotions", "on sale", "promocode", "promo code", "20%  off", "20%off", "20 percent off", "★★★★★", "☆", "⭐"]), []);
is("German", caught(["garantiert", "Garantie", "kostenlosen Versand", "kostenloser Versand", "Gratisversand", "versandkostenfrei", "Gutscheinen", "Gutscheincode", "rabattiert", "Rabattcode", "Sommerrabatte", "Sonderangebot"]), []);
is("French", caught(["garanti", "garantie", "soldes", "promotion"]), []);
is("Spanish", caught(["garantizado", "garantía", "rebajado", "rebajas", "promoción"]), []);
is("Portuguese", caught(["promoção", "promoções", "garantido", "garantia"]), []);
is("Italian", caught(["promozione", "garantito", "garanzia", "saldi"]), []);
is("Dutch", caught(["gegarandeerd", "uitverkoop", "garantie", "kortingsactie"]), []);
is("and in a reply they are refused when the store never wrote them", ["It is bestselling.", "It is on sale.", "Use the promocode.", "Rated ★★★★★.", "It is 20%  off.", "Kostenlosen Versand.", "Mit Gutscheinen.", "Garantiert.", "Rabattiert.", "Les soldes.", "Garanti.", "Garantizado.", "Rebajado.", "Em promoção.", "Garantido.", "In promozione.", "Gegarandeerd.", "De uitverkoop."].filter((reply) => heldToFacts(reply, "Pottery course. 20 lessons.")), []);

part("Fourth review: honest replies are allowed by the store's word in any of its forms");
is("the store's plural allows the singular, its accent the plain word", [heldToFacts("Ask about a discount for teams.", probe), heldToFacts("Use the cupon at checkout.", probe), heldToFacts("Use the cupón at checkout.", probe), heldToFacts("DISCOUNTS for teams.", probe)], [true, true, true, true]);
is("a curly or straight apostrophe, '%off' or '% off'", [
  heldToFacts("Aujourd'hui seulement.", "Aujourd’hui seulement."), heldToFacts("Aujourd’hui seulement.", "Aujourd'hui seulement."),
  heldToFacts("It is 20% off.", "Members get 20%off."), heldToFacts("It is 20%off.", "Members get 20 % off."),
], [true, true, true, true]);
is("a stem with an open ending allows the same word, plural or not", [heldToFacts("Mit Gutschein.", "Mit Gutscheinen."), heldToFacts("Garantias.", "Garantia de 7 dias."), heldToFacts("Es ist rabattiert.", "Alles rabattiert.")], [true, true, true]);
is("but not another word of that stem", [heldToFacts("Rabatt heute.", "Rabattcode im Mai."), heldToFacts("Rabatt heute.", "Frühlingsrabatt im Mai."), heldToFacts("A discount today.", "A discounted item.")], [false, false, false]);
is("ordinary replies pass", [heldToFacts("The Course costs $20 and has 20 lessons.", probe), heldToFacts("Café crème lessons, naïve style.", "Pottery."), heldToFacts("Don’t worry, it has 20 lessons.", probe)], [true, true, true]);
done();
