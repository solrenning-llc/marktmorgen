/**
 * The words of the box a buyer checks before something is handed over during
 * the 14-day cancellation period (lib/digital-consent.ts), in each language a
 * store can speak: the two sentences, the note under the box, what is said
 * when it was not checked, and the lines the confirmation email carries.
 *
 * `digital` is for digital content sold once: the express consent that
 * access begins before the cancellation period ends, and the acknowledgement
 * that the right is lost once it begins (Directive 2011/83/EU art. 16(m);
 * in German, § 356(6) no. 2 BGB: "ausdrücklich zugestimmt ..., dass ... vor
 * Ablauf der Widerrufsfrist beginnt" and "Kenntnis davon bestätigt ..., dass
 * ... mit Beginn der Vertragserfüllung sein Widerrufsrecht erlischt").
 * `membership` is for a membership, at least partly a service: the express
 * request to start now, and what a cancellation in the 14 days costs
 * (arts. 8(8), 14(3), 16(a)); it never says the right is lost. It ends by
 * naming the withdrawal function by the label the buyer's list of purchases
 * shows (lib/buyer-words/withdrawal.ts, withdrawLink) and saying it is there:
 * the pre-contract information on its existence and placement (art. 6(1)(h)
 * and Annex I as amended by Directive (EU) 2023/2673; queue item 588 [KB9]).
 * `digital` does not name it, and keeps the words of 2026-10-30.2: its own yes
 * closes the function once supplied, with the confirmation known sent
 * (lib/withdrawal-rules.ts, withdrawalWindow). Where the function is, for
 * every kind of purchase, is said beside the box, outside both sentences
 * (lib/buyer-words/withdrawal.ts, checkoutWhere; components/withdrawal-where.tsx).
 *
 * Both sentences are quoted back in the email, so a change to either in any
 * language is a new EU_WITHDRAWAL_CONSENT_VERSION and a new
 * CONSENT_WORDS_FINGERPRINT. Each language uses its own law's word for the
 * right. German speaks to the buyer as "Sie", as the store's German does.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";
import type { ConsentKind } from "@/lib/digital-consent";

export type DigitalConsentWords = {
  /** The sentence the buyer checks, by kind (lib/digital-consent.ts, consentKind). */
  box: Record<ConsentKind, string>;
  /** Under it: who it is for, and that paying needs it. */
  note: string;
  /** The same, where only a product added at checkout is opened at once, beside a shipped one. */
  noteAdded: string;
  /** Said beside the box when the payment was refused for want of it. */
  needed: string;
  /** The email's line: the sentence checked, its version and the day, then what follows for that order. */
  email: {
    /** Digital content handed over as soon as the order was confirmed. */
    now: (sentence: string, version: string, day: string) => string;
    /** A pre-order: access starts on the release day, and the right lasts until then. */
    release: (sentence: string, version: string, day: string) => string;
    /** A membership: the 14 days and what a cancellation in them costs. */
    membership: (sentence: string, version: string, day: string) => string;
    /** Added when the order also holds an item shipped to the buyer. */
    shipped: string;
  };
};

const en: DigitalConsentWords = {
  box: {
    digital: "Start my access before the 14-day cancellation period ends, as soon as it is available. I understand that once access starts, I lose my right to cancel.",
    membership: "Start my membership now, before the 14-day cancellation period ends. I understand that if I cancel within those 14 days, I pay for what I was given until then. To cancel, I can use ‘Withdraw from contract here’ on my purchases page.",
  },
  note: "This is for buyers who have that right where they live, such as in the EU and the UK. You need to check this box to pay.",
  noteAdded: "This is for buyers who have that right where they live, such as in the EU and the UK. It is only about an added product you can open right away: check it to pay for that one. A shipped item keeps its own right to cancel.",
  needed: "To pay, check this box first. Nothing was charged.",
  email: {
    now: (sentence, version, day) =>
      `At checkout on ${day}, you checked: “${sentence}” (wording ${version}). Access was given as soon as your order was confirmed, so a 14-day right to cancel, where you had one, ended then.`,
    release: (sentence, version, day) =>
      `At checkout on ${day}, you checked: “${sentence}” (wording ${version}). Access starts on the release day. Until then you keep any 14-day right to cancel you have; it ends when access starts.`,
    membership: (sentence, version, day) =>
      `At checkout on ${day}, you checked: “${sentence}” (wording ${version}). Where you have a 14-day right to cancel, you keep it: if you cancel within 14 days of joining, you pay only for what you were given until then.`,
    shipped: "An item shipped to you keeps its own 14-day right to cancel, where you have one, counted from the day you receive it.",
  },
};

const es: DigitalConsentWords = {
  box: {
    digital: "Pido que mi acceso empiece antes de que acabe el plazo de desistimiento de 14 días, en cuanto esté disponible. Entiendo que pierdo mi derecho de desistimiento en cuanto empieza el acceso.",
    membership: "Pido que mi suscripción empiece ya, antes de que acabe el plazo de desistimiento de 14 días. Entiendo que, si desisto en esos 14 días, pago lo que se me haya dado hasta entonces. Para desistir, puedo usar “Desistir del contrato aquí” en mis compras.",
  },
  note: "Es para quienes tienen ese derecho donde viven, como en la UE y el Reino Unido. Tienes que marcar esta casilla para pagar.",
  noteAdded: "Es para quienes tienen ese derecho donde viven, como en la UE y el Reino Unido. Solo afecta a un producto añadido que puedes abrir enseguida: márcala para pagarlo. Un artículo enviado conserva su propio derecho de desistimiento.",
  needed: "Para pagar, marca antes esta casilla. No se ha cobrado nada.",
  email: {
    now: (sentence, version, day) =>
      `Al hacer el pedido, el ${day}, marcaste: «${sentence}» (texto ${version}). El acceso se dio en cuanto se confirmó tu pedido, así que el derecho de desistimiento de 14 días, si lo tenías, terminó entonces.`,
    release: (sentence, version, day) =>
      `Al hacer el pedido, el ${day}, marcaste: «${sentence}» (texto ${version}). El acceso empieza el día del lanzamiento. Hasta entonces conservas el derecho de desistimiento de 14 días que tengas; termina cuando empieza el acceso.`,
    membership: (sentence, version, day) =>
      `Al hacer el pedido, el ${day}, marcaste: «${sentence}» (texto ${version}). Si tienes un derecho de desistimiento de 14 días, lo conservas: si desistes en los 14 días desde el alta, pagas solo lo que se te haya dado hasta entonces.`,
    shipped: "Un artículo que se te envía conserva su propio derecho de desistimiento de 14 días, si lo tienes, contado desde el día en que lo recibes.",
  },
};

const fr: DigitalConsentWords = {
  box: {
    digital: "Je demande que mon accès commence avant la fin du délai de rétractation de 14 jours, dès qu’il est disponible. Je reconnais perdre mon droit de rétractation dès que l’accès commence.",
    membership: "Je demande que mon abonnement commence maintenant, avant la fin du délai de rétractation de 14 jours. Je reconnais que, si je me rétracte dans ces 14 jours, je paie ce qui m’a été fourni jusque-là. Pour me rétracter, je peux utiliser « Se rétracter du contrat ici » dans mes achats.",
  },
  note: "C’est pour les acheteurs qui ont ce droit là où ils vivent, comme dans l’UE et au Royaume-Uni. Vous devez cocher cette case pour payer.",
  noteAdded: "C’est pour les acheteurs qui ont ce droit là où ils vivent, comme dans l’UE et au Royaume-Uni. Elle ne concerne qu’un produit ajouté que vous pouvez ouvrir tout de suite : cochez-la pour le payer. Un article expédié garde son propre droit de rétractation.",
  needed: "Pour payer, cochez d’abord cette case. Rien n’a été débité.",
  email: {
    now: (sentence, version, day) =>
      `Lors de la commande, le ${day}, vous avez coché : « ${sentence} » (texte ${version}). L’accès a été donné dès la confirmation de votre commande : le droit de rétractation de 14 jours, si vous l’aviez, a pris fin à ce moment-là.`,
    release: (sentence, version, day) =>
      `Lors de la commande, le ${day}, vous avez coché : « ${sentence} » (texte ${version}). L’accès commence le jour de la sortie. D’ici là, vous gardez le droit de rétractation de 14 jours que vous avez ; il prend fin quand l’accès commence.`,
    membership: (sentence, version, day) =>
      `Lors de la commande, le ${day}, vous avez coché : « ${sentence} » (texte ${version}). Si vous avez un droit de rétractation de 14 jours, vous le gardez : si vous vous rétractez dans les 14 jours suivant l’inscription, vous ne payez que ce qui vous a été fourni jusque-là.`,
    shipped: "Un article qui vous est expédié garde son propre droit de rétractation de 14 jours, si vous l’avez, compté à partir du jour où vous le recevez.",
  },
};

const de: DigitalConsentWords = {
  box: {
    digital: "Ich stimme ausdrücklich zu, dass mein Zugang vor Ablauf der 14-tägigen Widerrufsfrist beginnt, sobald er verfügbar ist. Mir ist bekannt, dass ich mit Beginn des Zugangs mein Widerrufsrecht verliere.",
    membership: "Ich verlange ausdrücklich, dass meine Mitgliedschaft jetzt beginnt, vor Ablauf der 14-tägigen Widerrufsfrist. Mir ist bekannt, dass ich bei einem Widerruf innerhalb dieser 14 Tage für das bis dahin Erhaltene zahle. Für einen Widerruf kann ich ‚Vertrag hier widerrufen‘ unter meinen Käufen nutzen.",
  },
  note: "Das gilt für Käufer, die dieses Recht dort haben, wo sie leben, etwa in der EU und im Vereinigten Königreich. Zum Bezahlen müssen Sie dieses Kästchen ankreuzen.",
  noteAdded: "Das gilt für Käufer, die dieses Recht dort haben, wo sie leben, etwa in der EU und im Vereinigten Königreich. Es betrifft nur ein hinzugefügtes Produkt, das Sie sofort öffnen können: Kreuzen Sie es an, um dieses zu bezahlen. Ein versandter Artikel behält sein eigenes Widerrufsrecht.",
  needed: "Kreuzen Sie zum Bezahlen zuerst dieses Kästchen an. Es wurde nichts berechnet.",
  email: {
    now: (sentence, version, day) =>
      `Bei der Bestellung am ${day} haben Sie angekreuzt: „${sentence}“ (Fassung ${version}). Der Zugang wurde gewährt, sobald Ihre Bestellung bestätigt war; ein 14-tägiges Widerrufsrecht, sofern Sie eines hatten, ist damit erloschen.`,
    release: (sentence, version, day) =>
      `Bei der Bestellung am ${day} haben Sie angekreuzt: „${sentence}“ (Fassung ${version}). Der Zugang beginnt am Erscheinungstag. Bis dahin behalten Sie ein 14-tägiges Widerrufsrecht, sofern Sie eines haben; es erlischt mit Beginn des Zugangs.`,
    membership: (sentence, version, day) =>
      `Bei der Bestellung am ${day} haben Sie angekreuzt: „${sentence}“ (Fassung ${version}). Sofern Sie ein 14-tägiges Widerrufsrecht haben, behalten Sie es: Widerrufen Sie innerhalb von 14 Tagen nach dem Beitritt, zahlen Sie nur für das bis dahin Erhaltene.`,
    shipped: "Ein an Sie versandter Artikel behält sein eigenes 14-tägiges Widerrufsrecht, sofern Sie eines haben, gerechnet ab dem Tag, an dem Sie ihn erhalten.",
  },
};

const it: DigitalConsentWords = {
  box: {
    digital: "Chiedo che il mio accesso inizi prima della fine del periodo di recesso di 14 giorni, appena è disponibile. Riconosco che perdo il diritto di recesso appena inizia l’accesso.",
    membership: "Chiedo che il mio abbonamento inizi subito, prima della fine del periodo di recesso di 14 giorni. Riconosco che, se recedo entro quei 14 giorni, pago quanto ricevuto fino ad allora. Per recedere, posso usare “Recedi dal contratto qui” nei miei acquisti.",
  },
  note: "Vale per chi ha questo diritto dove vive, come nell’UE e nel Regno Unito. Per pagare devi selezionare questa casella.",
  noteAdded: "Vale per chi ha questo diritto dove vive, come nell’UE e nel Regno Unito. Riguarda solo un prodotto aggiunto che puoi aprire subito: selezionala per pagarlo. Un articolo spedito mantiene il proprio diritto di recesso.",
  needed: "Per pagare, seleziona prima questa casella. Non è stato addebitato nulla.",
  email: {
    now: (sentence, version, day) =>
      `Al momento dell’ordine, il ${day}, hai selezionato: «${sentence}» (testo ${version}). L’accesso è stato dato appena il tuo ordine è stato confermato, quindi il diritto di recesso di 14 giorni, se ce l’avevi, è terminato allora.`,
    release: (sentence, version, day) =>
      `Al momento dell’ordine, il ${day}, hai selezionato: «${sentence}» (testo ${version}). L’accesso inizia il giorno dell’uscita. Fino ad allora mantieni il diritto di recesso di 14 giorni che hai; termina quando inizia l’accesso.`,
    membership: (sentence, version, day) =>
      `Al momento dell’ordine, il ${day}, hai selezionato: «${sentence}» (testo ${version}). Se hai un diritto di recesso di 14 giorni, lo mantieni: se recedi entro 14 giorni dall’iscrizione, paghi solo quanto ricevuto fino ad allora.`,
    shipped: "Un articolo spedito a te mantiene il proprio diritto di recesso di 14 giorni, se ce l’hai, contato dal giorno in cui lo ricevi.",
  },
};

const nl: DigitalConsentWords = {
  box: {
    digital: "Ik wil dat mijn toegang begint vóór het einde van de bedenktijd van 14 dagen, zodra het beschikbaar is. Ik begrijp dat ik mijn herroepingsrecht verlies zodra de toegang begint.",
    membership: "Ik wil dat mijn lidmaatschap nu begint, vóór het einde van de bedenktijd van 14 dagen. Ik begrijp dat ik, als ik binnen die 14 dagen herroep, betaal voor wat ik tot dan heb gekregen. Om te herroepen kan ik ‘Overeenkomst hier herroepen’ gebruiken bij mijn aankopen.",
  },
  note: "Dit is voor kopers die dat recht hebben waar ze wonen, zoals in de EU en het Verenigd Koninkrijk. Je moet dit vakje aanvinken om te betalen.",
  noteAdded: "Dit is voor kopers die dat recht hebben waar ze wonen, zoals in de EU en het Verenigd Koninkrijk. Het gaat alleen over een toegevoegd product dat je meteen kunt openen: vink het aan om dat te betalen. Een verzonden artikel houdt zijn eigen herroepingsrecht.",
  needed: "Vink eerst dit vakje aan om te betalen. Er is niets afgeschreven.",
  email: {
    now: (sentence, version, day) =>
      `Bij je bestelling op ${day} vinkte je aan: „${sentence}” (tekst ${version}). De toegang werd gegeven zodra je bestelling was bevestigd, dus een herroepingsrecht van 14 dagen, als je dat had, eindigde toen.`,
    release: (sentence, version, day) =>
      `Bij je bestelling op ${day} vinkte je aan: „${sentence}” (tekst ${version}). De toegang begint op de verschijningsdag. Tot dan houd je het herroepingsrecht van 14 dagen dat je hebt; het eindigt wanneer de toegang begint.`,
    membership: (sentence, version, day) =>
      `Bij je bestelling op ${day} vinkte je aan: „${sentence}” (tekst ${version}). Als je een herroepingsrecht van 14 dagen hebt, houd je het: herroep je binnen 14 dagen na je aanmelding, dan betaal je alleen voor wat je tot dan hebt gekregen.`,
    shipped: "Een artikel dat naar je wordt verzonden, houdt zijn eigen herroepingsrecht van 14 dagen, als je dat hebt, gerekend vanaf de dag dat je het ontvangt.",
  },
};

const pt: DigitalConsentWords = {
  box: {
    digital: "Peço que o meu acesso comece antes do fim do prazo de livre resolução de 14 dias, assim que estiver disponível. Reconheço que perco o direito de livre resolução quando o acesso começar.",
    membership: "Peço que a minha subscrição comece já, antes do fim do prazo de livre resolução de 14 dias. Reconheço que, se resolver o contrato nesses 14 dias, pago o que me foi prestado até lá. Para resolver o contrato, posso usar “Desistir do contrato aqui” nas minhas compras.",
  },
  note: "É para quem tem esse direito onde vive, como na UE e no Reino Unido. Tem de assinalar esta caixa para pagar.",
  noteAdded: "É para quem tem esse direito onde vive, como na UE e no Reino Unido. Diz respeito apenas a um produto adicionado que pode abrir logo: assinale-a para o pagar. Um artigo enviado mantém o seu próprio direito de livre resolução.",
  needed: "Para pagar, assinale primeiro esta caixa. Nada foi cobrado.",
  email: {
    now: (sentence, version, day) =>
      `Ao fazer a encomenda, a ${day}, assinalou: «${sentence}» (texto ${version}). O acesso foi dado assim que a sua encomenda foi confirmada, por isso o direito de livre resolução de 14 dias, se o tinha, terminou nesse momento.`,
    release: (sentence, version, day) =>
      `Ao fazer a encomenda, a ${day}, assinalou: «${sentence}» (texto ${version}). O acesso começa no dia do lançamento. Até lá, mantém o direito de livre resolução de 14 dias que tiver; termina quando o acesso começar.`,
    membership: (sentence, version, day) =>
      `Ao fazer a encomenda, a ${day}, assinalou: «${sentence}» (texto ${version}). Se tem um direito de livre resolução de 14 dias, mantém-no: se resolver o contrato nos 14 dias após a adesão, paga apenas o que lhe foi prestado até lá.`,
    shipped: "Um artigo que lhe é enviado mantém o seu próprio direito de livre resolução de 14 dias, se o tiver, contado a partir do dia em que o recebe.",
  },
};

/** Every language's words, in the order the fingerprint is taken in. */
export const DIGITAL_CONSENT_WORDS: Record<LanguageCode, DigitalConsentWords> = { en, es, fr, de, it, nl, pt };

export function digitalConsentWords(language: unknown): DigitalConsentWords {
  return DIGITAL_CONSENT_WORDS[parseLanguage(language)] ?? en;
}
