/**
 * The factual sentences of a store's policies (617 [SZ1], lib/store-policy-
 * facts.ts) in every language a store speaks to its buyers
 * (lib/store-language.ts). Each language says what English says, nothing
 * added and nothing softened, in the same form of address as the rest of the
 * store's words in it (Sie, vous, tú, je, o seu). The store's name and address
 * arrive already written; a sentence only places them. Browser-safe.
 */
import type { LanguageCode } from "@/lib/store-language";

export type PolicyWords = {
  /** The page's own title. */
  page: string;
  /** "Version" before the fingerprint of these words. */
  version: string;
  titles: { seller: string; cancel: string; memberships: string; measurement: string; contact: string };
  sellerIs: (name: string) => string;
  notParty: string;
  payments: (name: string, paypal: boolean) => string;
  cancelIntro: string;
  cancelDigital: string;
  cancelMembership: string;
  membersCancel: string;
  membersEnd: string;
  /** The word that joins the last two of a list ("Meta, Google and TikTok"). */
  and: string;
  measures: (name: string, pixels: string) => string;
  askFirst: string;
  gpc: string;
  postal: (name: string, address: string) => string;
  notAdvice: string;
};

/** A space a line cannot break at, before French ":". */
const S = " ";

export const POLICY_WORDS: Record<LanguageCode, PolicyWords> = {
  en: {
    page: "How this store works",
    version: "Version",
    titles: { seller: "Who sells", cancel: "Canceling within 14 days", memberships: "Memberships", measurement: "Ad measurement", contact: "Contact" },
    sellerIs: (n) => `${n} is the seller. Each sale is a contract between ${n} and the buyer.`,
    notParty: "Marktmorgen provides the store and its checkout. It is not a party to the sale and is not the merchant of record.",
    payments: (n, paypal) => `Payments go into ${n}'s own Stripe account${paypal ? ", or its own PayPal account when you pay with PayPal" : ""}.`,
    cancelIntro: "In the European Union, the United Kingdom and some other places, a consumer who buys online usually has 14 days to cancel.",
    cancelDigital:
      "For digital content, such as a file, a link, a course or a private podcast, that right ends once access starts only if you agreed at checkout that it may start within the 14 days, said you understood you would lose the right, and received a confirmation of both.",
    cancelMembership:
      "A membership is at least partly a service: at checkout you ask for it to start now, you keep the right to cancel within the 14 days, and if you do, you may be asked to pay for what you already received.",
    membersCancel: "You can cancel a membership yourself at any time, from the link in any email about it, without contacting anyone.",
    membersEnd: "Canceling ends the membership at the end of the period you already paid for.",
    and: "and",
    measures: (n, p) => `${n} measures its ads with ${p}.`,
    askFirst: "Where the law asks visitors first, nothing is measured until you say yes, and you can say no.",
    gpc: "If your browser sends Global Privacy Control, nothing is measured.",
    postal: (n, a) => `${n}'s postal address: ${a}.`,
    notAdvice:
      "This page describes how this store works and is updated by itself when its settings change. It is not legal advice, and it does not say that the store meets any particular law.",
  },
  es: {
    page: "Cómo funciona esta tienda",
    version: "Versión",
    titles: { seller: "Quién vende", cancel: "Cancelar en 14 días", memberships: "Membresías", measurement: "Medición de anuncios", contact: "Contacto" },
    sellerIs: (n) => `${n} es quien vende. Cada venta es un contrato entre ${n} y quien compra.`,
    notParty: "Marktmorgen ofrece la tienda y su pago. No es parte de la venta ni actúa como comerciante registrado.",
    payments: (n, paypal) => `Los pagos van a la propia cuenta de Stripe de ${n}${paypal ? ", o a su propia cuenta de PayPal cuando pagas con PayPal" : ""}.`,
    cancelIntro: "En la Unión Europea, el Reino Unido y algunos otros lugares, quien compra en línea como consumidor suele tener 14 días para cancelar.",
    cancelDigital:
      "Para el contenido digital, como un archivo, un enlace, un curso o un pódcast privado, ese derecho termina cuando empieza el acceso solo si aceptaste al pagar que empezara dentro de los 14 días, dijiste que entendías que perderías el derecho y recibiste una confirmación de ambas cosas.",
    cancelMembership:
      "Una membresía es, al menos en parte, un servicio: al pagar pides que empiece ya, conservas el derecho a cancelar dentro de los 14 días y, si lo haces, se te puede pedir que pagues lo que ya recibiste.",
    membersCancel: "Puedes cancelar una membresía por tu cuenta en cualquier momento, desde el enlace de cualquier correo sobre ella, sin contactar con nadie.",
    membersEnd: "Al cancelar, la membresía termina al final del período que ya pagaste.",
    and: "y",
    measures: (n, p) => `${n} mide sus anuncios con ${p}.`,
    askFirst: "Donde la ley pide preguntar primero a quien visita, no se mide nada hasta que dices que sí, y puedes decir que no.",
    gpc: "Si tu navegador envía Global Privacy Control, no se mide nada.",
    postal: (n, a) => `Dirección postal de ${n}: ${a}.`,
    notAdvice:
      "Esta página describe cómo funciona esta tienda y se actualiza sola cuando cambian sus ajustes. No es asesoramiento jurídico y no dice que la tienda cumpla ninguna ley en particular.",
  },
  fr: {
    page: "Comment fonctionne cette boutique",
    version: "Version",
    titles: { seller: "Qui vend", cancel: "Se rétracter dans les 14 jours", memberships: "Abonnements", measurement: "Mesure des publicités", contact: "Contact" },
    sellerIs: (n) => `${n} est le vendeur. Chaque vente est un contrat entre ${n} et l'acheteur.`,
    notParty: "Marktmorgen fournit la boutique et son paiement. Marktmorgen n'est pas partie à la vente et n'agit pas comme vendeur officiel.",
    payments: (n, paypal) => `Les paiements vont sur le propre compte Stripe de ${n}${paypal ? ", ou sur son propre compte PayPal quand vous payez avec PayPal" : ""}.`,
    cancelIntro: "Dans l'Union européenne, au Royaume-Uni et dans certains autres pays, un consommateur qui achète en ligne dispose en général de 14 jours pour se rétracter.",
    cancelDigital:
      "Pour un contenu numérique, comme un fichier, un lien, une formation ou un podcast privé, ce droit prend fin au début de l'accès seulement si vous avez accepté au paiement qu'il commence dans les 14 jours, déclaré comprendre que vous perdriez ce droit et reçu une confirmation des deux.",
    cancelMembership: `Un abonnement est au moins en partie un service${S}: au paiement, vous demandez qu'il commence tout de suite, vous gardez le droit de vous rétracter dans les 14 jours et, si vous le faites, il peut vous être demandé de payer ce que vous avez déjà reçu.`,
    membersCancel: "Vous pouvez résilier un abonnement vous-même à tout moment, depuis le lien de n'importe quel e-mail à son sujet, sans contacter personne.",
    membersEnd: "La résiliation met fin à l'abonnement à la fin de la période déjà payée.",
    and: "et",
    measures: (n, p) => `${n} mesure ses publicités avec ${p}.`,
    askFirst: "Là où la loi demande d'abord l'accord des visiteurs, rien n'est mesuré tant que vous n'avez pas dit oui, et vous pouvez dire non.",
    gpc: "Si votre navigateur envoie Global Privacy Control, rien n'est mesuré.",
    postal: (n, a) => `Adresse postale de ${n}${S}: ${a}.`,
    notAdvice:
      "Cette page décrit le fonctionnement de cette boutique et se met à jour d'elle-même quand ses réglages changent. Ce n'est pas un conseil juridique, et elle ne dit pas que la boutique respecte une loi en particulier.",
  },
  de: {
    page: "So funktioniert dieser Shop",
    version: "Version",
    titles: { seller: "Wer verkauft", cancel: "Widerruf innerhalb von 14 Tagen", memberships: "Mitgliedschaften", measurement: "Messung von Werbung", contact: "Kontakt" },
    sellerIs: (n) => `${n} ist der Verkäufer. Jeder Verkauf ist ein Vertrag zwischen ${n} und der kaufenden Person.`,
    notParty: "Marktmorgen stellt den Shop und die Kasse bereit. Marktmorgen ist nicht Partei des Verkaufs und tritt nicht als Händler auf.",
    payments: (n, paypal) => `Zahlungen gehen auf das eigene Stripe-Konto von ${n}${paypal ? " oder, wenn Sie mit PayPal zahlen, auf das eigene PayPal-Konto" : ""}.`,
    cancelIntro: "In der Europäischen Union, im Vereinigten Königreich und an einigen anderen Orten haben Verbraucher beim Online-Kauf in der Regel 14 Tage Zeit für einen Widerruf.",
    cancelDigital:
      "Bei digitalen Inhalten wie einer Datei, einem Link, einem Kurs oder einem privaten Podcast erlischt dieses Recht mit Beginn des Zugangs nur, wenn Sie an der Kasse zugestimmt haben, dass er innerhalb der 14 Tage beginnt, erklärt haben, dass Sie wissen, dass Sie das Recht dadurch verlieren, und eine Bestätigung von beidem erhalten haben.",
    cancelMembership:
      "Eine Mitgliedschaft ist zumindest teilweise eine Dienstleistung: An der Kasse verlangen Sie, dass sie sofort beginnt, Sie behalten das Recht, innerhalb der 14 Tage zu widerrufen, und wenn Sie das tun, kann von Ihnen verlangt werden, für bereits Erhaltenes zu zahlen.",
    membersCancel: "Sie können eine Mitgliedschaft jederzeit selbst kündigen, über den Link in jeder E-Mail dazu, ohne jemanden kontaktieren zu müssen.",
    membersEnd: "Mit der Kündigung endet die Mitgliedschaft am Ende des bereits bezahlten Zeitraums.",
    and: "und",
    measures: (n, p) => `${n} misst seine Werbung mit ${p}.`,
    askFirst: "Wo das Gesetz verlangt, Besucher zuerst zu fragen, wird nichts gemessen, bevor Sie Ja sagen, und Sie können Nein sagen.",
    gpc: "Wenn Ihr Browser Global Privacy Control sendet, wird nichts gemessen.",
    postal: (n, a) => `Postanschrift von ${n}: ${a}.`,
    notAdvice:
      "Diese Seite beschreibt, wie dieser Shop funktioniert, und aktualisiert sich selbst, wenn sich seine Einstellungen ändern. Sie ist keine Rechtsberatung und sagt nicht, dass der Shop ein bestimmtes Gesetz einhält.",
  },
  it: {
    page: "Come funziona questo negozio",
    version: "Versione",
    titles: { seller: "Chi vende", cancel: "Recesso entro 14 giorni", memberships: "Abbonamenti", measurement: "Misurazione degli annunci", contact: "Contatti" },
    sellerIs: (n) => `${n} è il venditore. Ogni vendita è un contratto tra ${n} e chi acquista.`,
    notParty: "Marktmorgen fornisce il negozio e il pagamento. Non è parte della vendita e non agisce come venditore registrato.",
    payments: (n, paypal) => `I pagamenti vanno sul conto Stripe di ${n}${paypal ? ", oppure sul suo conto PayPal quando paghi con PayPal" : ""}.`,
    cancelIntro: "Nell'Unione europea, nel Regno Unito e in alcuni altri luoghi, chi acquista online come consumatore di solito ha 14 giorni per recedere.",
    cancelDigital:
      "Per i contenuti digitali, come un file, un link, un corso o un podcast privato, questo diritto termina all'inizio dell'accesso solo se al pagamento hai accettato che iniziasse entro i 14 giorni, hai dichiarato di capire che avresti perso il diritto e hai ricevuto una conferma di entrambe le cose.",
    cancelMembership:
      "Un abbonamento è almeno in parte un servizio: al pagamento chiedi che inizi subito, conservi il diritto di recedere entro i 14 giorni e, se lo fai, ti può essere chiesto di pagare ciò che hai già ricevuto.",
    membersCancel: "Puoi disdire un abbonamento da solo in qualsiasi momento, dal link in qualsiasi email che lo riguarda, senza contattare nessuno.",
    membersEnd: "Con la disdetta, l'abbonamento termina alla fine del periodo già pagato.",
    and: "e",
    measures: (n, p) => `${n} misura i suoi annunci con ${p}.`,
    askFirst: "Dove la legge chiede prima il consenso a chi visita, non viene misurato nulla finché non dici di sì, e puoi dire di no.",
    gpc: "Se il tuo browser invia Global Privacy Control, non viene misurato nulla.",
    postal: (n, a) => `Indirizzo postale di ${n}: ${a}.`,
    notAdvice:
      "Questa pagina descrive come funziona questo negozio e si aggiorna da sola quando cambiano le sue impostazioni. Non è una consulenza legale e non afferma che il negozio rispetti una legge in particolare.",
  },
  nl: {
    page: "Hoe deze winkel werkt",
    version: "Versie",
    titles: { seller: "Wie verkoopt", cancel: "Annuleren binnen 14 dagen", memberships: "Lidmaatschappen", measurement: "Meten van advertenties", contact: "Contact" },
    sellerIs: (n) => `${n} is de verkoper. Elke verkoop is een overeenkomst tussen ${n} en de koper.`,
    notParty: "Marktmorgen levert de winkel en de betaling. Marktmorgen is geen partij bij de verkoop en treedt niet op als verkoper.",
    payments: (n, paypal) => `Betalingen gaan naar de eigen Stripe-rekening van ${n}${paypal ? ", of naar de eigen PayPal-rekening als je met PayPal betaalt" : ""}.`,
    cancelIntro: "In de Europese Unie, het Verenigd Koninkrijk en enkele andere plaatsen heeft een consument die online koopt meestal 14 dagen om te annuleren.",
    cancelDigital:
      "Bij digitale inhoud, zoals een bestand, een link, een cursus of een privépodcast, vervalt dat recht zodra de toegang begint alleen als je bij het afrekenen hebt ingestemd dat die binnen de 14 dagen mag beginnen, hebt verklaard te begrijpen dat je het recht dan verliest, en een bevestiging van beide hebt ontvangen.",
    cancelMembership:
      "Een lidmaatschap is ten minste gedeeltelijk een dienst: bij het afrekenen vraag je om het meteen te laten beginnen, je houdt het recht om binnen de 14 dagen te annuleren en als je dat doet, kan je gevraagd worden te betalen voor wat je al hebt gekregen.",
    membersCancel: "Je kunt een lidmaatschap op elk moment zelf opzeggen, via de link in elke e-mail erover, zonder contact op te nemen.",
    membersEnd: "Opzeggen beëindigt het lidmaatschap aan het einde van de periode die je al hebt betaald.",
    and: "en",
    measures: (n, p) => `${n} meet zijn advertenties met ${p}.`,
    askFirst: "Waar de wet vraagt bezoekers eerst te vragen, wordt niets gemeten tot je ja zegt, en je kunt nee zeggen.",
    gpc: "Als je browser Global Privacy Control verstuurt, wordt niets gemeten.",
    postal: (n, a) => `Postadres van ${n}: ${a}.`,
    notAdvice:
      "Deze pagina beschrijft hoe deze winkel werkt en wordt vanzelf bijgewerkt als de instellingen veranderen. Het is geen juridisch advies en zegt niet dat de winkel aan een bepaalde wet voldoet.",
  },
  pt: {
    page: "Como esta loja funciona",
    version: "Versão",
    titles: { seller: "Quem vende", cancel: "Cancelar no prazo de 14 dias", memberships: "Subscrições", measurement: "Medição de anúncios", contact: "Contacto" },
    sellerIs: (n) => `${n} é o vendedor. Cada venda é um contrato entre ${n} e o comprador.`,
    notParty: "A Marktmorgen fornece a loja e o pagamento. Não é parte na venda nem atua como vendedor registado.",
    payments: (n, paypal) => `Os pagamentos são feitos para a própria conta Stripe de ${n}${paypal ? ", ou para a própria conta PayPal da loja quando paga com PayPal" : ""}.`,
    cancelIntro: "Na União Europeia, no Reino Unido e noutros lugares, um consumidor que compra online tem normalmente 14 dias para cancelar.",
    cancelDigital:
      "Para conteúdo digital, como um ficheiro, uma ligação, um curso ou um podcast privado, esse direito termina quando o acesso começa apenas se, no pagamento, aceitou que começasse dentro dos 14 dias, declarou compreender que perderia o direito e recebeu uma confirmação de ambos.",
    cancelMembership:
      "Uma subscrição é, pelo menos em parte, um serviço: no pagamento pede que comece de imediato, mantém o direito de cancelar dentro dos 14 dias e, se o fizer, pode ter de pagar o que já recebeu.",
    membersCancel: "Pode cancelar uma subscrição a qualquer momento, pela ligação em qualquer e-mail sobre ela, sem contactar ninguém.",
    membersEnd: "Ao cancelar, a subscrição termina no fim do período já pago.",
    and: "e",
    measures: (n, p) => `${n} mede os seus anúncios com ${p}.`,
    askFirst: "Onde a lei exige perguntar primeiro a quem visita, nada é medido até dizer que sim, e pode dizer que não.",
    gpc: "Se o seu navegador enviar Global Privacy Control, nada é medido.",
    postal: (n, a) => `Morada postal de ${n}: ${a}.`,
    notAdvice:
      "Esta página descreve como esta loja funciona e atualiza-se sozinha quando as definições mudam. Não é aconselhamento jurídico e não afirma que a loja cumpre uma lei em particular.",
  },
};
