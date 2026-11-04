/**
 * The words a blog post kept for members says where an email kept for
 * members says "email" (lib/store-blog.ts, lib/letter-access.ts): the rest of
 * its door is lib/buyer-words/letters.ts, shared. In the store's language.
 * Browser-safe.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const en = {
  /** To the creator, when none of the products they chose is left. */
  noneLeft: "None of the products you chose is on your store anymore, so only you can read it. Open it in your studio and choose others, or none to open it to everyone.",
  closedBody: (email: string) => `${email} has none of the products that open this post, or a membership that did has stopped. If you used another address, ask for a link with it below.`,
  /** After asking for a link to read it (?link=sent). */
  sentBody: "If that address has one of these products, a link to read this post is on its way. It works for one hour.",
};

export type MemberPostWords = typeof en;

const es: MemberPostWords = {
  noneLeft: "Ninguno de los productos que elegiste sigue en tu tienda, así que solo tú puedes leerla. Ábrela en tu estudio y elige otros, o ninguno para abrirla a todos.",
  closedBody: (email) => `${email} no tiene ninguno de los productos que abren esta publicación, o una membresía que la abría se detuvo. Si usaste otra dirección, pide un enlace con ella abajo.`,
  sentBody: "Si esa dirección tiene uno de estos productos, va en camino un enlace para leer esta publicación. Funciona durante una hora.",
};

const fr: MemberPostWords = {
  noneLeft: "Aucun des produits choisis n'est encore dans votre boutique : vous seul pouvez le lire. Ouvrez-le dans votre studio et choisissez-en d'autres, ou aucun pour l'ouvrir à tous.",
  closedBody: (email) => `${email} n'a aucun des produits qui ouvrent cet article, ou un abonnement qui l'ouvrait s'est arrêté. Si vous avez utilisé une autre adresse, demandez un lien avec elle ci-dessous.`,
  sentBody: "Si cette adresse a l'un de ces produits, un lien pour lire cet article est en route. Il fonctionne pendant une heure.",
};

const de: MemberPostWords = {
  noneLeft: "Keines der gewählten Produkte ist noch in Ihrem Shop, daher können nur Sie ihn lesen. Öffnen Sie ihn in Ihrem Studio und wählen Sie andere, oder keines, um ihn für alle zu öffnen.",
  closedBody: (email) => `${email} hat keines der Produkte, die diesen Beitrag öffnen, oder eine Mitgliedschaft, die ihn geöffnet hat, ist beendet. Wenn Sie eine andere Adresse verwendet haben, fordern Sie unten damit einen Link an.`,
  sentBody: "Wenn diese Adresse eines dieser Produkte hat, ist ein Link zum Lesen dieses Beitrags unterwegs. Er gilt eine Stunde.",
};

const it: MemberPostWords = {
  noneLeft: "Nessuno dei prodotti scelti è più nel tuo negozio, quindi solo tu puoi leggerlo. Aprilo nel tuo studio e scegline altri, oppure nessuno per aprirlo a tutti.",
  closedBody: (email) => `${email} non ha nessuno dei prodotti che aprono questo articolo, oppure un abbonamento che lo apriva si è fermato. Se hai usato un altro indirizzo, chiedi un link con quello qui sotto.`,
  sentBody: "Se quell'indirizzo ha uno di questi prodotti, sta arrivando un link per leggere questo articolo. Funziona per un'ora.",
};

const nl: MemberPostWords = {
  noneLeft: "Geen van de gekozen producten staat nog in je winkel, dus alleen jij kunt het lezen. Open het in je studio en kies andere, of geen om het voor iedereen open te zetten.",
  closedBody: (email) => `${email} heeft geen van de producten die dit bericht openen, of een lidmaatschap dat dat deed is gestopt. Gebruikte je een ander adres? Vraag daarmee hieronder een link aan.`,
  sentBody: "Als dat adres een van deze producten heeft, is er een link onderweg om dit bericht te lezen. Hij werkt een uur.",
};

const pt: MemberPostWords = {
  noneLeft: "Nenhum dos produtos escolhidos está mais na sua loja, então só você pode ler. Abra no seu estúdio e escolha outros, ou nenhum para abrir a todos.",
  closedBody: (email) => `${email} não tem nenhum dos produtos que abrem este post, ou uma assinatura que o abria parou. Se usou outro endereço, peça um link com ele abaixo.`,
  sentBody: "Se esse endereço tem um destes produtos, um link para ler este post está a caminho. Ele funciona por uma hora.",
};

export const MEMBER_POST_WORDS: Record<LanguageCode, MemberPostWords> = { en, es, fr, de, it, nl, pt };

export function memberPostWords(language: unknown): MemberPostWords {
  return MEMBER_POST_WORDS[parseLanguage(language)];
}
