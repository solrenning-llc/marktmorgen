/**
 * The words of a deal or of pressure that a reply of the store assistant,
 * its next product after a purchase and its checkout reminder may use only
 * when the store's own text does (DEAL_WORDS, heldToFacts in
 * lib/store-assistant-rules.ts): singular and plural, in every language a
 * store can speak, whole words only (edge tests of 4 November 2026: plurals
 * such as "discounts" and "five stars" passed).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEAL_WORDS, heldToFacts } from "@/lib/store-assistant-rules";
import { latinLookalikes, renderTable, versionOf } from "../scripts/confusables-latin-table.mjs";
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
is("a look-alike letter with no deal word in it is not refused", heldToFacts("The \u0441ourse has 20 lessons.", probe), true);
is("hidden with no deal in the facts too", [heldToFacts("A dis\u0441ount.", "nothing"), heldToFacts("dis.count", "nothing"), heldToFacts("\uFF52\uFF41\uFF42\uFF41\uFF54\uFF54", "nichts")], [false, false, false]);
is("a number in another script is compared as its ASCII digits", [
  heldToFacts("It costs $\uFF12\uFF10.", probe), heldToFacts("It costs $\u0662\u0660.", probe),
  heldToFacts("It costs $\uFF13\uFF10.", probe), heldToFacts("It costs $\u0663\u0660.", probe), heldToFacts("Only \u09E9\u09E6 lessons.", probe),
  heldToFacts("It costs $2\u200B0.", probe), heldToFacts("Only 2\u00B2 left.", "Only 2 left."),
], [true, true, false, false, false, true, false]);
is("a link in fullwidth letters is refused", heldToFacts("See \uFF57\uFF57\uFF57\uFF0Eexample\uFF0Ecom", probe), false);
is("the reply shown is never changed by the folding", (() => { const text = "Ask about the Cupón."; heldToFacts(text, probe); return text; })(), "Ask about the Cupón.");

part("Fourth review: forms that were missed");
is("English", caught(["bestselling", "best-selling", "promotion", "promotions", "on sale", "promocode", "promo code", "20%  off", "20%off", "20 percent off", "\u2605\u2605\u2605\u2605\u2605", "\u2606", "\u2B50"]), []);
is("German", caught(["garantiert", "Garantie", "kostenlosen Versand", "kostenloser Versand", "Gratisversand", "versandkostenfrei", "Gutscheinen", "Gutscheincode", "rabattiert", "Rabattcode", "Sommerrabatte", "Sonderangebot"]), []);
is("French", caught(["garanti", "garantie", "soldes", "promotion"]), []);
is("Spanish", caught(["garantizado", "garantía", "rebajado", "rebajas", "promoción"]), []);
is("Portuguese", caught(["promoção", "promoções", "garantido", "garantia"]), []);
is("Italian", caught(["promozione", "garantito", "garanzia", "saldi"]), []);
is("Dutch", caught(["gegarandeerd", "uitverkoop", "garantie", "kortingsactie"]), []);
is("and in a reply they are refused when the store never wrote them", ["It is bestselling.", "It is on sale.", "Use the promocode.", "Rated \u2605\u2605\u2605\u2605\u2605.", "It is 20%  off.", "Kostenlosen Versand.", "Mit Gutscheinen.", "Garantiert.", "Rabattiert.", "Les soldes.", "Garanti.", "Garantizado.", "Rebajado.", "Em promoção.", "Garantido.", "In promozione.", "Gegarandeerd.", "De uitverkoop."].filter((reply) => heldToFacts(reply, "Pottery course. 20 lessons.")), []);

part("Fourth review: honest replies are allowed by the store's word in any of its forms");
is("the store's plural allows the singular, its accent the plain word", [heldToFacts("Ask about a discount for teams.", probe), heldToFacts("Use the cupon at checkout.", probe), heldToFacts("Use the cupón at checkout.", probe), heldToFacts("DISCOUNTS for teams.", probe)], [true, true, true, true]);
is("a curly or straight apostrophe, '%off' or '% off'", [
  heldToFacts("Aujourd'hui seulement.", "Aujourd’hui seulement."), heldToFacts("Aujourd’hui seulement.", "Aujourd'hui seulement."),
  heldToFacts("It is 20% off.", "Members get 20%off."), heldToFacts("It is 20%off.", "Members get 20 % off."),
], [true, true, true, true]);
is("a stem with an open ending allows the same word, plural or not", [heldToFacts("Mit Gutschein.", "Mit Gutscheinen."), heldToFacts("Garantias.", "Garantia de 7 dias."), heldToFacts("Es ist rabattiert.", "Alles rabattiert.")], [true, true, true]);
is("but not another word of that stem", [heldToFacts("Rabatt heute.", "Rabattcode im Mai."), heldToFacts("Rabatt heute.", "Frühlingsrabatt im Mai."), heldToFacts("A discount today.", "A discounted item.")], [false, false, false]);
is("ordinary replies pass", [heldToFacts("The Course costs $20 and has 20 lessons.", probe), heldToFacts("Café crème lessons, naïve style.", "Pottery."), heldToFacts("Don’t worry, it has 20 lessons.", probe)], [true, true, true]);

part("Fifth review: honest text in any script, and compounds the store wrote with a hyphen");
const sameFacts = (reply: string) => heldToFacts(reply, reply);
is("text in another script, with a Latin word inside, passes", [
  heldToFacts("Python\u30B3\u30FC\u30B9\u306F\u521D\u5FC3\u8005\u5411\u3051\u3067\u3059\u3002", "Python\u30B3\u30FC\u30B9 \u521D\u5FC3\u8005\u5411\u3051"), heldToFacts("Excel\u306E\u4F7F\u3044\u65B9\u3092\u5B66\u3079\u307E\u3059\u3002", "Excel\u306E\u4F7F\u3044\u65B9"), heldToFacts("\u8FD9\u662FPython\u8BFE\u7A0B\u3002", "Python\u8BFE\u7A0B"),
  sameFacts("Python\uC73C\uB85C \uBC30\uC6B0\uB294 \uB370\uC774\uD130 \uBD84\uC11D"), sameFacts("\u05D4\u05E7\u05D5\u05E8\u05E1 \u05D1-Python \u05DE\u05D9\u05D5\u05E2\u05D3 \u05DC\u05DE\u05EA\u05D7\u05D9\u05DC\u05D9\u05DD"), sameFacts("\u062F\u0648\u0631\u0629 \u0627\u0644\u0640Python \u0644\u0644\u0645\u0628\u062A\u062F\u0626\u064A\u0646"),
  heldToFacts("Each capsule has 500 \u00B5g.", "500 \u00B5g per capsule"), heldToFacts("Each capsule has 500 \u03BCg.", "500 \u03BCg per capsule"), heldToFacts("Rich in \u03B2-carotene.", "Rich in \u03B2-carotene"),
  heldToFacts("Uses a 10 k\u03A9 resistor.", "10 k\u03A9 resistor"), heldToFacts("\u0627\u0644\u0633\u0639\u0631 \u0662\u0667 \u062F\u0648\u0644\u0627\u0631", "\u0627\u0644\u0633\u0639\u0631 27 \u062F\u0648\u0644\u0627\u0631"),
], [true, true, true, true, true, true, true, true, true, true, true]);
is("a compound the store wrote with a hyphen may be repeated", [
  heldToFacts("Der Sommer-Rabatt gilt bis Juli.", "Sommer-Rabatt bis Juli."), heldToFacts("Ein Geschenk-Gutschein ist erhältlich.", "Geschenk-Gutschein erhältlich."),
  sameFacts("Gratis-Versand für alle Bestellungen."), heldToFacts("De Black-Friday-korting geldt.", "Black-Friday-korting"), sameFacts("Versandkosten-frei."),
  heldToFacts("Der E-Book-Gutschein ist da.", "E-Book-Gutschein"), heldToFacts("Ein Geschenk-Gutschein.", "Ein Geschenkgutschein."),
], [true, true, true, true, true, true, true]);
is("but not the stem alone, with a hyphen in the facts or without", [heldToFacts("Ein Gutschein.", "Geschenk-Gutschein erhältlich."), heldToFacts("Ein Gutschein.", "Ein Geschenkgutschein."), heldToFacts("Der Rabatt.", "Sommer-Rabatt.")], [false, false, false]);
is("and a compound the store never wrote is refused", [heldToFacts("Der Sommer-Rabatt.", "Kurs."), heldToFacts("Mega-Uitverkoop!", "Cursus."), heldToFacts("Versandkosten-frei.", "Kurs.")], [false, false, false]);
is("an apostrophe written as a modifier letter", heldToFacts("Offre valable aujourd\u02BChui seulement.", "Aujourd'hui seulement"), true);

part("Fifth review: a deal word spelled with look-alike letters, with no Latin letter in it");
const lookalikes = [
  "Use the \u0441\u043E\u0501\u0435 at checkout.", "Everything is on \u0455\u0430\u04CF\u0435 this week.", "Courses are \u0585\u0578 \u0455\u0430\u04CF\u0435.", "Ask for a \u0441\u03BF\u057D\u0440\u03BF\u0578.", "Ask for a \u1D05\u026A\uA731\u1D04\u1D0F\u1D1C\u0274\u1D1B.",
  "Ask for a \u{1F173}\u{1F178}\u{1F182}\u{1F172}\u{1F17E}\u{1F184}\u{1F17D}\u{1F183}.", "Ask for a \u{1F153}\u{1F158}\u{1F162}\u{1F152}\u{1F15E}\u{1F164}\u{1F15D}\u{1F163}.", "Ask for a \u249F\u24A4\u24AE\u249E\u24AA\u24B0\u24A9\u24AF.", "Ask for a \u{1F1E9}\u{1F1EE}\u{1F1F8}\u{1F1E8}\u{1F1F4}\u{1F1FA}\u{1F1F3}\u{1F1F9}.", "Everything is on \u13DA\u13AA\u13DE\u13AC.",
];
is("each is refused, though the facts have the word in Latin letters", lookalikes.filter((reply) => heldToFacts(reply, `${probe} Use the code. On sale.`)), []);
is("unless the store spelled it with the same letters", heldToFacts("Use the \u0441\u043E\u0501\u0435.", "Use the \u0441\u043E\u0501\u0435."), true);

part("Fifth review: every split of a word is joined for the deal-word check");
is("each split is refused", ["Get a dis..count today.", "Get a d i s c o u n t.", "Get a dis\ncount.", "Get a dis/count.", "Get a dis\u2009count.", "Get a dis\u00A0count.", "Get a dis-_-count."].filter((reply) => heldToFacts(reply, probe)), []);
is("while ordinary punctuation and letters pass", [heldToFacts("Lessons 1/2 and Q&A.", "Lessons 1 and 2."), heldToFacts("I am a b c learner.", "ABC."), heldToFacts("Don't miss the A/B test lesson.", "A/B")], [true, true, true]);

part("Fifth review: links and bare domains");
is("a bare domain the facts do not have is refused", [heldToFacts("See evil.example/deal for more.", probe), heldToFacts("Visit cheap-courses.shop today.", probe), heldToFacts("Visit \uFF43\uFF48\uFF45\uFF41\uFF50\uFF0E\uFF53\uFF48\uFF4F\uFF50 today.", probe), heldToFacts("See www.example.com", probe)], [false, false, false, false]);
is("one the store wrote is allowed, and names with a dot are not domains", [heldToFacts("Write to us at mystore.com.", "Our site is mystore.com."), heldToFacts("Learn Node.js, e.g. Vue.js.", "Node.js course")], [true, true]);

part("Sixth review: a split is joined only inside a sentence, and the store's own split word may be repeated");
const plans = "Plans: Basic and Pro. Pro-Mode included.";
is("a line that ends a sentence or starts with a capital is never joined to the next", [
  heldToFacts("Choose Pro.\nMost creators start there.", plans), heldToFacts("Pick Pro!\nMore help below.", plans),
  heldToFacts("Upgrade to Pro\nMonthly or yearly.", plans), heldToFacts("Grab a cup\nOn Monday", plans),
], [true, true, true, true]);
is("the store's own split word, written the same way", [heldToFacts("Pro-Mode is included.", plans), heldToFacts("The Pro/Monthly plan.", "The Pro/Monthly plan."), heldToFacts("Pro\u00B7Mobile app.", "Pro\u00B7Mobile app.")], [true, true, true]);
is("but not the split word written another way, nor one the store never wrote", [heldToFacts("Pro.Mode is included.", plans), heldToFacts("Pro-Motion today.", plans), heldToFacts("Get a dis\ncount.", probe)], [false, false, false]);

part("Sixth review: look-alike letters from Unicode's confusables, in every script");
const deals = `${probe} Use the code. On sale. 20% off.`;
is("each is refused, though the facts have the word in Latin letters", [
  "Ask for a \uA4D3\uA4F2\uA4E2\uA4DA\uA4F3\uA4F4\uA4E0\uA4D4.", "On \uA4E2\uA4EE\uA4E1\uA4F0 now.", "It is 20 % \uA4F3\uA4DD\uA4DD.", "Ask for a \u2CA5\u2C9F\u057D\u2CA3\u2C9F\u0578.", "Use the \u0441\u043E\uA4D3\u0435.", "Use the c\u{104EB}de.", "Use the \u{10302}\u{104EB}de.", "Use the \u1455\u1D0F\u15EA\u1D07.", "Use the c\u2D54de.",
  "Ask for a D\u0406SCOUNT.", "Ask for a d\u0406scount.",
].filter((reply) => heldToFacts(reply, deals)), []);
is("honest Lisu, Coptic and Tifinagh text passes", [heldToFacts("\uA4E1\uA4F2-\uA4E2\uA4F4 \uA4DF\uA4EC \uA4D2\uA4F5.", "Lisu."), heldToFacts("\u2CA0\u2C93\u2C9B\u2C9F\u2CA9\u03EF.", "Coptic."), heldToFacts("\u2D5C\u2D30\u2D4E\u2D30\u2D63\u2D49\u2D56\u2D5C.", "Tifinagh.")], [true, true, true]);
const copy = readFileSync("tooling/unicode/confusables-18.0.0.txt", "utf8");
is("the table is made from the committed copy of confusables.txt, version 18.0.0", [versionOf(copy).version, readFileSync("lib/confusables-latin.ts", "utf8") === renderTable(copy)], ["18.0.0", true]);
const table = new Map(latinLookalikes(copy));
is("it keeps letters of other scripts and leaves accented letters, digits, Arabic, Hebrew and Han out", [
  table.get(0xa4d3), table.get(0x2ca5), table.get(0x10302), table.get(0x2d54), table.get(0x0441), table.get(0x0406),
  table.has(0x00e9), table.has(0x0660), table.has(0x0627), table.has(0x05d5), table.has(0x4e00), table.has(0x2282),
], ["d", "c", "c", "o", "c", "l|i", false, false, false, false, false, false]);

part("Sixth review: email addresses, domains and stars");
is("an email address the facts do not have is refused", [heldToFacts("Email refunds@other-shop.com for help.", probe), heldToFacts("Write to mailto:x@evil.com", probe), heldToFacts("Email ana@example.com.", "Pottery.")], [false, false, false]);
is("one the store wrote is allowed", heldToFacts("Email hello@mystore.com for help.", "Write to hello@mystore.com."), true);
is("file names, libraries and a capital after a dot are not domains", [
  heldToFacts("Download logo.ai here.", probe), heldToFacts("It uses socket.io.", probe), heldToFacts("Built with ASP.NET.", probe),
  heldToFacts("That was great.It helped.", probe), heldToFacts("Learn Node.js/React.", probe),
], [true, true, true, true, true]);
is("while a site with a path is still refused", [heldToFacts("See evil.example/deal for more.", probe), heldToFacts("See CHEAP.SHOP/now", probe)], [false, false]);
is("more star ratings", caught(["\u22C6\u22C6\u22C6\u22C6\u22C6", "\u2B52", "\u{1F320}"]), []);

part("Seventh review: the vendored copy, its license, domains in any case, and look-alikes with a mark");
is("the copy of confusables.txt is the one read on 4 November 2026", createHash("sha256").update(readFileSync("tooling/unicode/confusables-18.0.0.txt")).digest("hex"), "6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92");
is("its license is beside it, the one read from the same repository, and the generated table cites it", [
  createHash("sha256").update(readFileSync("tooling/unicode/LICENSE")).digest("hex"), readFileSync("lib/confusables-latin.ts", "utf8").includes("Unicode License v3 (tooling/unicode/LICENSE)"),
], ["fe5c62b543e287981db198f2acfa0ca732d12591a1024536dc8fd85dacd77104", true]);
is("a domain in any case, or after a slash or an underscore, is refused", [
  heldToFacts("Visit Evil.Com today", probe), heldToFacts("Visit EVIL.COM today", probe), heldToFacts("See //evil.com/x", probe), heldToFacts("See /evil.com", probe), heldToFacts("See _evil.com", probe),
  heldToFacts("Visit Evil.Me/now", probe),
], [false, false, false, false, false, false]);
is("a word that starts a sentence after a dot, and the library names, still pass", [heldToFacts("That was great.It helped.", probe), heldToFacts("Go there.In the morning.", probe), heldToFacts("Built with ASP.NET.", probe), heldToFacts("It uses socket.io.", probe)], [true, true, true, true]);
is("a look-alike that confusables.txt reads as a letter with a mark is read as the letter", [heldToFacts("Use the \uABAF\uABBB\u13A0\u13AC.", deals), heldToFacts("Everything is o\u03B7 sale.", deals)], [false, false]);
is("so the table has them", [table.get(0x03b7), table.get(0x13eb), table.get(0xabbb)], ["n", "o", "o"]);

part("Final review: a sentence that starts right after a dot with a word that is also a domain ending");
is("honest replies pass", [
  heldToFacts("Uma aula.Eu gostei.", "Aula."), heldToFacts("Muito bom.Se quiser, pergunte.", "Aula."), heldToFacts("Twelve lessons.Live sessions too.", "Lessons."),
  heldToFacts("Lessons.Top quality.", "Lessons."), heldToFacts("That was great.It's fun.", probe), heldToFacts("That was great.It\nhelps.", probe), heldToFacts("That was great.It", probe),
  heldToFacts("Ottimo corso.Io lo consiglio.", "Corso."), heldToFacts("Goede cursus.Net als vorig jaar.", "Cursus."),
], [true, true, true, true, true, true, true, true, true]);
is("while a site in any case is still refused", [
  heldToFacts("Visit Evil.Com today", probe), heldToFacts("Visit EVIL.COM today", probe), heldToFacts("See //evil.com/x", probe), heldToFacts("See /evil.com", probe),
  heldToFacts("See _evil.com", probe), heldToFacts("Visit evil.eu today", probe), heldToFacts("Visit Evil.Eu/now", probe), heldToFacts("Visit EVIL.EU now", probe),
], [false, false, false, false, false, false, false, false]);
done();
