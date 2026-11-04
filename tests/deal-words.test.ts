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
is("none of these", ["A barcode scanner", "The Codex class", "A promotion at work", "Encoded lessons", "Ultimatum", "Garantir la qualité", "Sconfitta e rinascita", "Rabattieren", "Ein Scontrino"].filter((t) => DEAL_WORDS.test(t)), []);

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
done();
