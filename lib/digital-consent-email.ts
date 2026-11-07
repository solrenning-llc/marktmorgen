/**
 * The line a purchase's confirmation email carries when the buyer checked the
 * box to start during the cancellation period (lib/digital-consent.ts): the confirmation on a
 * durable medium that Directive 2011/83/EU asks for (art. 8(7)(b), art.
 * 16(m)(iii)). It quotes the sentence that was checked, its version and the
 * day, and says what follows for that order (see consentEmailLines). Read
 * from the order's own metadata, so the email says what the order holds and
 * nothing else; no yes on the order, no line.
 *
 * Every version ever shown is kept in WORDS_BY_VERSION, so an email sent just
 * after a change of words still quotes the words that buyer checked. When
 * EU_WITHDRAWAL_CONSENT_VERSION is bumped, the previous words move into it.
 */
import { type ConsentKind, readConsentMeta, EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { DIGITAL_CONSENT_WORDS } from "@/lib/buyer-words/digital-consent";
import { speechFor } from "@/lib/buyer-words";
import { parseLanguage } from "@/lib/store-language";

/**
 * The two sentences of 2026-10-30.2, before the membership one named the
 * withdrawal function and where it is (queue item 588 [KB9], unit 2); the
 * digital one is unchanged since (tests/kb9-precontract.test.ts). Sales were closed
 * while they were current, but an order kept with them is still quoted with
 * the words it holds, never with today's.
 */
export const BOX_2026_10_30_2: Record<keyof typeof DIGITAL_CONSENT_WORDS, Record<ConsentKind, string>> = {
  en: {
    digital: "Start my access before the 14-day cancellation period ends, as soon as it is available. I understand that once access starts, I lose my right to cancel.",
    membership: "Start my membership now, before the 14-day cancellation period ends. I understand that if I cancel within those 14 days, I pay for what I was given until then.",
  },
  es: {
    digital: "Pido que mi acceso empiece antes de que acabe el plazo de desistimiento de 14 días, en cuanto esté disponible. Entiendo que pierdo mi derecho de desistimiento en cuanto empieza el acceso.",
    membership: "Pido que mi suscripción empiece ya, antes de que acabe el plazo de desistimiento de 14 días. Entiendo que, si desisto en esos 14 días, pago lo que se me haya dado hasta entonces.",
  },
  fr: {
    digital: "Je demande que mon accès commence avant la fin du délai de rétractation de 14 jours, dès qu’il est disponible. Je reconnais perdre mon droit de rétractation dès que l’accès commence.",
    membership: "Je demande que mon abonnement commence maintenant, avant la fin du délai de rétractation de 14 jours. Je reconnais que, si je me rétracte dans ces 14 jours, je paie ce qui m’a été fourni jusque-là.",
  },
  de: {
    digital: "Ich stimme ausdrücklich zu, dass mein Zugang vor Ablauf der 14-tägigen Widerrufsfrist beginnt, sobald er verfügbar ist. Mir ist bekannt, dass ich mit Beginn des Zugangs mein Widerrufsrecht verliere.",
    membership: "Ich verlange ausdrücklich, dass meine Mitgliedschaft jetzt beginnt, vor Ablauf der 14-tägigen Widerrufsfrist. Mir ist bekannt, dass ich bei einem Widerruf innerhalb dieser 14 Tage für das bis dahin Erhaltene zahle.",
  },
  it: {
    digital: "Chiedo che il mio accesso inizi prima della fine del periodo di recesso di 14 giorni, appena è disponibile. Riconosco che perdo il diritto di recesso appena inizia l’accesso.",
    membership: "Chiedo che il mio abbonamento inizi subito, prima della fine del periodo di recesso di 14 giorni. Riconosco che, se recedo entro quei 14 giorni, pago quanto ricevuto fino ad allora.",
  },
  nl: {
    digital: "Ik wil dat mijn toegang begint vóór het einde van de bedenktijd van 14 dagen, zodra het beschikbaar is. Ik begrijp dat ik mijn herroepingsrecht verlies zodra de toegang begint.",
    membership: "Ik wil dat mijn lidmaatschap nu begint, vóór het einde van de bedenktijd van 14 dagen. Ik begrijp dat ik, als ik binnen die 14 dagen herroep, betaal voor wat ik tot dan heb gekregen.",
  },
  pt: {
    digital: "Peço que o meu acesso comece antes do fim do prazo de livre resolução de 14 dias, assim que estiver disponível. Reconheço que perco o direito de livre resolução quando o acesso começar.",
    membership: "Peço que a minha subscrição comece já, antes do fim do prazo de livre resolução de 14 dias. Reconheço que, se resolver o contrato nesses 14 dias, pago o que me foi prestado até lá.",
  },
};

/** Every language's words with an earlier version's two sentences; the email's other lines are the same. */
function withBox(box: typeof BOX_2026_10_30_2): typeof DIGITAL_CONSENT_WORDS {
  const words = { ...DIGITAL_CONSENT_WORDS };
  for (const lang of Object.keys(box) as (keyof typeof box)[]) words[lang] = { ...DIGITAL_CONSENT_WORDS[lang], box: box[lang] };
  return words;
}

const WORDS_BY_VERSION: Record<string, typeof DIGITAL_CONSENT_WORDS> = {
  // 2026-10-30.1 was never shown to a buyer (sales were closed) and kept no kind, so it is not quoted.
  "2026-10-30.2": withBox(BOX_2026_10_30_2),
  [EU_WITHDRAWAL_CONSENT_VERSION]: DIGITAL_CONSENT_WORDS,
};

/**
 * The email's lines for the yes on this order, a blank line first; none when
 * the order has no yes this code can quote. Says only what is true of that
 * order: a membership keeps its 14 days at a proportional price; a pre-order
 * keeps the right until its release day (its metadata says "preorder"); any
 * other digital order was opened as soon as it was confirmed. An order that
 * also ships an item (metadata "ship") says that item keeps its own right.
 */
export function consentEmailLines(store: { language: unknown; currency: string }, meta: Record<string, string | undefined> | null | undefined): string[] {
  const consent = readConsentMeta(meta);
  if (!consent) return [];
  const words = WORDS_BY_VERSION[consent.version]?.[parseLanguage(store.language)];
  if (!words) return [];
  const day = speechFor(store.language, store.currency).date(consent.at * 1000);
  const sentence = words.box[consent.kind];
  const line =
    consent.kind === "membership"
      ? words.email.membership(sentence, consent.version, day)
      : meta?.preorder === "yes"
        ? words.email.release(sentence, consent.version, day)
        : words.email.now(sentence, consent.version, day);
  return ["", meta?.ship === "yes" ? `${line} ${words.email.shipped}` : line];
}
