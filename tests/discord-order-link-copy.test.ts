import { readFileSync } from "node:fs";
import { DISCORD_WORDS } from "@/lib/buyer-words/discord";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, string> = {
  en: "Nothing bought with this address comes with the Discord server now. If you have an order link for the address you paid with, open it and use the Discord button there.",
  es: "Nada comprado con esta dirección incluye ahora el servidor de Discord. Si tienes un enlace de pedido para la dirección con la que pagaste, ábrelo y usa allí el botón de Discord.",
  fr: "Rien de ce qui a été acheté avec cette adresse ne donne accès au serveur Discord en ce moment. Si vous avez un lien de commande pour l'adresse utilisée pour payer, ouvrez-le et utilisez le bouton Discord qui s'y trouve.",
  de: "Nichts, was mit dieser Adresse gekauft wurde, gehört derzeit zum Discord-Server. Wenn Sie einen Bestelllink für die beim Bezahlen verwendete Adresse haben, öffnen Sie ihn und nutzen Sie dort die Discord-Schaltfläche.",
  it: "Niente di ciò che è stato acquistato con questo indirizzo include ora il server Discord. Se hai un link dell'ordine per l'indirizzo con cui hai pagato, aprilo e usa lì il pulsante Discord.",
  nl: "Niets wat met dit adres is gekocht, hoort nu bij de Discord-server. Heb je een bestellink voor het adres waarmee je betaalde, open die dan en gebruik daar de Discord-knop.",
  pt: "Nada do que foi comprado com este endereço dá agora acesso ao servidor de Discord. Se tiver uma ligação para a encomenda associada ao endereço com que pagou, abra-a e use aí o botão do Discord.",
};

const TITLES: Record<LanguageCode, string> = {
  en: "No purchase with Discord access",
  es: "Ninguna compra con acceso a Discord",
  fr: "Aucun achat avec accès à Discord",
  de: "Kein Kauf mit Discord-Zugang",
  it: "Nessun acquisto con accesso a Discord",
  nl: "Geen aankoop met toegang tot Discord",
  pt: "Nenhuma compra com acesso ao Discord",
};

part("The no-purchase notice points to existing order evidence without claiming email delivery");
for (const code of LANGUAGE_CODES) {
  const notice = DISCORD_WORDS[code].notices.none;
  is(`${code}: renders the complete evidence-bound instruction`, notice.body, EXPECTED[code]);
  is(`${code}: keeps the no-purchase title`, notice.title, TITLES[code]);
  is(`${code}: keeps the address-specific explanation`, /address|dirección|adresse|indirizzo|adres|endereço/i.test(notice.body), true);
}

const page = readFileSync("app/[handle]/discord/page.tsx", "utf8");
is("the real callback page selects the localized notice from the callback status", page.includes("w.notices[status as keyof typeof w.notices]"), true);
is("the real callback page performs no email delivery-status read", /sendEmail|deliveryStatus|inboxStatus/.test(page), false);
done();
