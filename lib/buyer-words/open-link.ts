/**
 * The page an emailed community, course or letter link lands on (MM-SA-41,
 * MM-SA-53; app/[handle]/{community,course,letters}/open/page.tsx),
 * in the store's language (lib/store-language.ts). Plain words: the link is
 * good, one tap opens it, and why the tap is asked for.
 *
 * Browser-safe: plain data, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type OpenLinkWords = {
  title: string;
  heading: string;
  lead: (store: string) => string;
  community: string;
  course: string;
  letter: string;
  pending: string;
  why: string;
  bad: string;
};

export const OPEN_LINK_WORDS: Record<LanguageCode, OpenLinkWords> = {
  en: {
    title: "Open your link",
    heading: "One tap and you are in",
    lead: (store) => `Your link from ${store} is good. Tap the button to open it on this device.`,
    community: "Open the community",
    course: "Open my courses",
    letter: "Open the email",
    pending: "Opening…",
    why: "We ask for this tap because mail programs open the links in a message to check them. This way a program never uses up your link.",
    bad: "This link is not complete. Open the email again and tap the link in it, or ask for a new one.",
  },
  es: {
    title: "Abre tu enlace",
    heading: "Un toque y ya estás dentro",
    lead: (store) => `Tu enlace de ${store} es válido. Toca el botón para abrirlo en este dispositivo.`,
    community: "Abrir la comunidad",
    course: "Abrir mis cursos",
    letter: "Abrir el email",
    pending: "Abriendo…",
    why: "Te pedimos este toque porque los programas de correo abren los enlaces de un mensaje para revisarlos. Así ningún programa gasta tu enlace.",
    bad: "Este enlace no está completo. Abre de nuevo el correo y toca el enlace, o pide uno nuevo.",
  },
  fr: {
    title: "Ouvrez votre lien",
    heading: "Un geste et vous y êtes",
    lead: (store) => `Votre lien de ${store} est valide. Touchez le bouton pour l’ouvrir sur cet appareil.`,
    community: "Ouvrir la communauté",
    course: "Ouvrir mes cours",
    letter: "Ouvrir l’e-mail",
    pending: "Ouverture…",
    why: "Nous vous demandons ce geste parce que les logiciels de messagerie ouvrent les liens d’un message pour les vérifier. Ainsi, aucun logiciel n’utilise votre lien à votre place.",
    bad: "Ce lien est incomplet. Rouvrez l’e-mail et touchez le lien qu’il contient, ou demandez-en un nouveau.",
  },
  de: {
    title: "Link öffnen",
    heading: "Ein Tippen, und Sie sind drin",
    lead: (store) => `Ihr Link von ${store} ist gültig. Tippen Sie auf die Schaltfläche, um ihn auf diesem Gerät zu öffnen.`,
    community: "Community öffnen",
    course: "Meine Kurse öffnen",
    letter: "E-Mail öffnen",
    pending: "Wird geöffnet…",
    why: "Wir bitten um dieses Tippen, weil E-Mail-Programme die Links in einer Nachricht öffnen, um sie zu prüfen. So verbraucht kein Programm Ihren Link.",
    bad: "Dieser Link ist unvollständig. Öffnen Sie die E-Mail erneut und tippen Sie auf den Link darin, oder fordern Sie einen neuen an.",
  },
  it: {
    title: "Apri il tuo link",
    heading: "Un tocco e sei dentro",
    lead: (store) => `Il tuo link da ${store} è valido. Tocca il pulsante per aprirlo su questo dispositivo.`,
    community: "Apri la community",
    course: "Apri i miei corsi",
    letter: "Apri l’email",
    pending: "Apertura…",
    why: "Ti chiediamo questo tocco perché i programmi di posta aprono i link di un messaggio per controllarli. Così nessun programma consuma il tuo link.",
    bad: "Questo link non è completo. Riapri l’email e tocca il link che contiene, oppure chiedine uno nuovo.",
  },
  nl: {
    title: "Open je link",
    heading: "Eén tik en je bent binnen",
    lead: (store) => `Je link van ${store} is geldig. Tik op de knop om hem op dit apparaat te openen.`,
    community: "De community openen",
    course: "Mijn cursussen openen",
    letter: "De e-mail openen",
    pending: "Openen…",
    why: "We vragen om deze tik omdat e-mailprogramma’s de links in een bericht openen om ze te controleren. Zo verbruikt geen enkel programma je link.",
    bad: "Deze link is niet compleet. Open de e-mail opnieuw en tik op de link erin, of vraag een nieuwe aan.",
  },
  pt: {
    title: "Abra a sua ligação",
    heading: "Um toque e está dentro",
    lead: (store) => `A sua ligação de ${store} é válida. Toque no botão para a abrir neste dispositivo.`,
    community: "Abrir a comunidade",
    course: "Abrir os meus cursos",
    letter: "Abrir o email",
    pending: "A abrir…",
    why: "Pedimos este toque porque os programas de email abrem as ligações de uma mensagem para as verificar. Assim, nenhum programa gasta a sua ligação.",
    bad: "Esta ligação está incompleta. Abra novamente o email e toque na ligação que contém, ou peça uma nova.",
  },
};

export function openLinkWords(language: unknown): OpenLinkWords {
  return OPEN_LINK_WORDS[parseLanguage(language)];
}
