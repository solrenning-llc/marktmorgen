/**
 * The page an emailed community or course link lands on (MM-SA-41;
 * app/[handle]/community/open/page.tsx, app/[handle]/course/open/page.tsx),
 * in the store's language (lib/store-language.ts). Plain words: the link is
 * ready, one press opens it, and why the press is asked for.
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
  pending: string;
  why: string;
  bad: string;
};

export const OPEN_LINK_WORDS: Record<LanguageCode, OpenLinkWords> = {
  en: {
    title: "Open your link",
    heading: "Open your link",
    lead: (store) => `Your link from ${store} is ready to use. Select the button to open it on this device.`,
    community: "Open the community",
    course: "Open my courses",
    pending: "Opening…",
    why: "We ask you to select the button because mail programs open the links in a message to check them. This way a program never uses up your link.",
    bad: "This link is not complete. Open the email again and select the link in it, or ask for a new one.",
  },
  es: {
    title: "Abre tu enlace",
    heading: "Abre tu enlace",
    lead: (store) => `Tu enlace de ${store} está listo. Selecciona el botón para abrirlo en este dispositivo.`,
    community: "Abrir la comunidad",
    course: "Abrir mis cursos",
    pending: "Abriendo…",
    why: "Te pedimos que selecciones el botón porque los programas de correo abren los enlaces de un mensaje para revisarlos. Así ningún programa gasta tu enlace.",
    bad: "Este enlace no está completo. Abre de nuevo el correo y selecciona el enlace, o pide uno nuevo.",
  },
  fr: {
    title: "Ouvrez votre lien",
    heading: "Ouvrez votre lien",
    lead: (store) => `Votre lien de ${store} est prêt. Sélectionnez le bouton pour l’ouvrir sur cet appareil.`,
    community: "Ouvrir la communauté",
    course: "Ouvrir mes cours",
    pending: "Ouverture…",
    why: "Nous vous demandons de sélectionner le bouton parce que les logiciels de messagerie ouvrent les liens d’un message pour les vérifier. Ainsi, aucun logiciel n’utilise votre lien à votre place.",
    bad: "Ce lien est incomplet. Rouvrez l’e-mail et sélectionnez le lien qu’il contient, ou demandez-en un nouveau.",
  },
  de: {
    title: "Link öffnen",
    heading: "Link öffnen",
    lead: (store) => `Ihr Link von ${store} ist bereit. Wählen Sie die Schaltfläche, um ihn auf diesem Gerät zu öffnen.`,
    community: "Community öffnen",
    course: "Meine Kurse öffnen",
    pending: "Wird geöffnet…",
    why: "Wir bitten Sie, die Schaltfläche zu wählen, weil E-Mail-Programme die Links in einer Nachricht öffnen, um sie zu prüfen. So verbraucht kein Programm Ihren Link.",
    bad: "Dieser Link ist unvollständig. Öffnen Sie die E-Mail erneut und wählen Sie den Link darin, oder fordern Sie einen neuen an.",
  },
  it: {
    title: "Apri il tuo link",
    heading: "Apri il tuo link",
    lead: (store) => `Il tuo link da ${store} è pronto. Seleziona il pulsante per aprirlo su questo dispositivo.`,
    community: "Apri la community",
    course: "Apri i miei corsi",
    pending: "Apertura…",
    why: "Ti chiediamo di selezionare il pulsante perché i programmi di posta aprono i link di un messaggio per controllarli. Così nessun programma consuma il tuo link.",
    bad: "Questo link non è completo. Riapri l’email e seleziona il link che contiene, oppure chiedine uno nuovo.",
  },
  nl: {
    title: "Open je link",
    heading: "Open je link",
    lead: (store) => `Je link van ${store} staat klaar. Kies de knop om hem op dit apparaat te openen.`,
    community: "De community openen",
    course: "Mijn cursussen openen",
    pending: "Openen…",
    why: "We vragen je de knop te kiezen omdat e-mailprogramma’s de links in een bericht openen om ze te controleren. Zo verbruikt geen enkel programma je link.",
    bad: "Deze link is niet compleet. Open de e-mail opnieuw en kies de link erin, of vraag een nieuwe aan.",
  },
  pt: {
    title: "Abra a sua ligação",
    heading: "Abra a sua ligação",
    lead: (store) => `A sua ligação de ${store} está pronta. Selecione o botão para a abrir neste dispositivo.`,
    community: "Abrir a comunidade",
    course: "Abrir os meus cursos",
    pending: "A abrir…",
    why: "Pedimos que selecione o botão porque os programas de email abrem as ligações de uma mensagem para as verificar. Assim, nenhum programa gasta a sua ligação.",
    bad: "Esta ligação está incompleta. Abra novamente o email e selecione a ligação que contém, ou peça uma nova.",
  },
};

export function openLinkWords(language: unknown): OpenLinkWords {
  return OPEN_LINK_WORDS[parseLanguage(language)];
}
