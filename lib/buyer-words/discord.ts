/**
 * The words of Discord access (lib/discord-rules.ts), as a buyer meets them,
 * in the store's language (lib/store-language.ts): the button on the thanks
 * page and on their orders, and the page Discord sends them back to.
 *
 * Every language says all English says, nothing added and nothing softened.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

type Notice = { title: string; body: string };

const en = {
  joinButton: "Join the Discord",
  thanksNote: (store: string) => `This comes with ${store}'s Discord server. Press the button, say yes on Discord's own page, and you are in, with your roles.`,
  ordersNote: "Opens the Discord server that comes with it.",
  pageTitle: "Discord",
  joinedTitle: "You are in",
  joinedBody: (store: string) => `You are in ${store}'s Discord server, with the roles that come with what you bought.`,
  openDiscord: "Open Discord",
  keepNote: "The roles stay while what you bought is yours. When a membership ends or a purchase is refunded in full, they are taken back at the next check.",
  backToStore: (store: string) => `Back to ${store}`,
  notices: {
    declined: { title: "Nothing was changed", body: "You said no on Discord's page. Press the button again whenever you want to join." },
    none: { title: "No purchase with Discord access", body: "Nothing bought with this address comes with the Discord server now. Open your orders from the email sent to the address you paid with, and use the button there." },
    failed: { title: "Discord did not let you in just now", body: "Nothing was changed. Try again in a few minutes. If it keeps happening, the store's owner may need to check the server's settings." },
    off: { title: "This store has no Discord server connected", body: "Nothing was changed. The store's owner can tell you where its community is." },
    expired: { title: "That took too long", body: "For your safety, the way back from Discord works for ten minutes. Press the button again." },
  } satisfies Record<string, Notice>,
};

export type DiscordWords = Omit<typeof en, "notices" | "thanksNote" | "joinedBody" | "backToStore"> & {
  thanksNote: (store: string) => string;
  joinedBody: (store: string) => string;
  backToStore: (store: string) => string;
  notices: Record<keyof typeof en.notices, Notice>;
};

const es: DiscordWords = {
  joinButton: "Unirme al Discord",
  thanksNote: (store) => `Esto incluye el servidor de Discord de ${store}. Pulsa el botón, acepta en la propia página de Discord y ya estás dentro, con tus roles.`,
  ordersNote: "Abre el servidor de Discord que viene con la compra.",
  pageTitle: "Discord · acceso",
  joinedTitle: "Ya estás dentro",
  joinedBody: (store) => `Ya estás en el servidor de Discord de ${store}, con los roles que vienen con lo que compraste.`,
  openDiscord: "Abrir Discord",
  keepNote: "Los roles se mantienen mientras lo que compraste sea tuyo. Si una membresía termina o se reembolsa una compra por completo, se retiran en la siguiente comprobación.",
  backToStore: (store) => `Volver a ${store}`,
  notices: {
    declined: { title: "No se cambió nada", body: "Dijiste que no en la página de Discord. Pulsa el botón de nuevo cuando quieras unirte." },
    none: { title: "Ninguna compra con acceso a Discord", body: "Nada comprado con esta dirección incluye ahora el servidor de Discord. Abre tus pedidos desde el email enviado a la dirección con la que pagaste y usa el botón de allí." },
    failed: { title: "Discord no te dejó entrar ahora", body: "No se cambió nada. Inténtalo de nuevo en unos minutos. Si sigue pasando, puede que el dueño de la tienda tenga que revisar la configuración del servidor." },
    off: { title: "Esta tienda no tiene un servidor de Discord conectado", body: "No se cambió nada. El dueño de la tienda puede decirte dónde está su comunidad." },
    expired: { title: "Pasó demasiado tiempo", body: "Por tu seguridad, la vuelta desde Discord funciona durante diez minutos. Pulsa el botón otra vez." },
  },
};

const fr: DiscordWords = {
  joinButton: "Rejoindre le Discord",
  thanksNote: (store) => `Cet achat donne accès au serveur Discord de ${store}. Appuyez sur le bouton, acceptez sur la page de Discord elle-même, et vous y êtes, avec vos rôles.`,
  ordersNote: "Ouvre le serveur Discord qui va avec cet achat.",
  pageTitle: "Accès Discord",
  joinedTitle: "Vous y êtes",
  joinedBody: (store) => `Vous êtes sur le serveur Discord de ${store}, avec les rôles qui vont avec votre achat.`,
  openDiscord: "Ouvrir Discord",
  keepNote: "Les rôles restent tant que votre achat vous appartient. Quand un abonnement prend fin ou qu'un achat est remboursé en totalité, ils sont retirés lors de la prochaine vérification.",
  backToStore: (store) => `Retour à ${store}`,
  notices: {
    declined: { title: "Rien n'a été modifié", body: "Vous avez refusé sur la page de Discord. Appuyez de nouveau sur le bouton quand vous voulez rejoindre le serveur." },
    none: { title: "Aucun achat avec accès à Discord", body: `Rien de ce qui a été acheté avec cette adresse ne donne accès au serveur Discord en ce moment. Ouvrez vos commandes depuis l'e-mail envoyé à l'adresse utilisée pour payer, et utilisez le bouton qui s'y trouve.` },
    failed: { title: "Discord ne vous a pas laissé entrer pour l'instant", body: "Rien n'a été modifié. Réessayez dans quelques minutes. Si cela se reproduit, le propriétaire de la boutique devra peut-être vérifier les réglages du serveur." },
    off: { title: "Aucun serveur Discord n'est relié à cette boutique", body: "Rien n'a été modifié. Le propriétaire de la boutique peut vous dire où se trouve sa communauté." },
    expired: { title: `C'était trop long`, body: `Pour votre sécurité, le retour depuis Discord fonctionne dix minutes. Appuyez de nouveau sur le bouton.` },
  },
};

const de: DiscordWords = {
  joinButton: "Dem Discord beitreten",
  thanksNote: (store) => `Dazu gehört der Discord-Server von ${store}. Tippen Sie auf die Schaltfläche, stimmen Sie auf der Seite von Discord zu, und Sie sind dabei, mit Ihren Rollen.`,
  ordersNote: "Öffnet den Discord-Server, der dazugehört.",
  pageTitle: "Discord-Zugang",
  joinedTitle: "Sie sind dabei",
  joinedBody: (store) => `Sie sind auf dem Discord-Server von ${store}, mit den Rollen, die zu Ihrem Kauf gehören.`,
  openDiscord: "Discord öffnen",
  keepNote: "Die Rollen bleiben, solange Ihnen gehört, was Sie gekauft haben. Endet eine Mitgliedschaft oder wird ein Kauf vollständig erstattet, werden sie bei der nächsten Prüfung entzogen.",
  backToStore: (store) => `Zurück zu ${store}`,
  notices: {
    declined: { title: "Nichts wurde geändert", body: "Sie haben auf der Seite von Discord abgelehnt. Tippen Sie erneut auf die Schaltfläche, wann immer Sie beitreten möchten." },
    none: { title: "Kein Kauf mit Discord-Zugang", body: "Nichts, was mit dieser Adresse gekauft wurde, gehört derzeit zum Discord-Server. Öffnen Sie Ihre Bestellungen über die E-Mail an die Adresse, mit der Sie bezahlt haben, und nutzen Sie dort die Schaltfläche." },
    failed: { title: "Discord hat Sie gerade nicht hineingelassen", body: "Nichts wurde geändert. Versuchen Sie es in ein paar Minuten erneut. Passiert es wieder, muss die Inhaberin oder der Inhaber des Shops vielleicht die Einstellungen des Servers prüfen." },
    off: { title: "Mit diesem Shop ist kein Discord-Server verbunden", body: "Nichts wurde geändert. Die Inhaberin oder der Inhaber des Shops kann Ihnen sagen, wo die Community ist." },
    expired: { title: "Das hat zu lange gedauert", body: "Zu Ihrer Sicherheit funktioniert der Rückweg von Discord zehn Minuten lang. Tippen Sie erneut auf die Schaltfläche." },
  },
};

const it: DiscordWords = {
  joinButton: "Entra nel Discord",
  thanksNote: (store) => `Con questo acquisto hai accesso al server Discord di ${store}. Premi il pulsante, accetta sulla pagina di Discord e sei dentro, con i tuoi ruoli.`,
  ordersNote: "Apre il server Discord incluso nell'acquisto.",
  pageTitle: "Accesso a Discord",
  joinedTitle: "Sei dentro",
  joinedBody: (store) => `Sei nel server Discord di ${store}, con i ruoli inclusi in ciò che hai acquistato.`,
  openDiscord: "Apri Discord",
  keepNote: "I ruoli restano finché ciò che hai acquistato è tuo. Quando un abbonamento finisce o un acquisto viene rimborsato per intero, vengono tolti al controllo successivo.",
  backToStore: (store) => `Torna a ${store}`,
  notices: {
    declined: { title: "Non è cambiato nulla", body: "Hai rifiutato sulla pagina di Discord. Premi di nuovo il pulsante quando vuoi entrare." },
    none: { title: "Nessun acquisto con accesso a Discord", body: "Niente di ciò che è stato acquistato con questo indirizzo include ora il server Discord. Apri i tuoi ordini dall'email inviata all'indirizzo con cui hai pagato e usa il pulsante che trovi lì." },
    failed: { title: "Discord non ti ha fatto entrare per ora", body: "Non è cambiato nulla. Riprova tra qualche minuto. Se succede ancora, il titolare del negozio potrebbe dover controllare le impostazioni del server." },
    off: { title: "Questo negozio non ha un server Discord collegato", body: "Non è cambiato nulla. Il titolare del negozio può dirti dov'è la sua community." },
    expired: { title: "È passato troppo tempo", body: "Per la tua sicurezza, il ritorno da Discord funziona per dieci minuti. Premi di nuovo il pulsante." },
  },
};

const nl: DiscordWords = {
  joinButton: "Word lid van de Discord",
  thanksNote: (store) => `Hierbij hoort de Discord-server van ${store}. Druk op de knop, zeg ja op de eigen pagina van Discord en je bent binnen, met je rollen.`,
  ordersNote: "Opent de Discord-server die erbij hoort.",
  pageTitle: "Toegang tot Discord",
  joinedTitle: "Je bent binnen",
  joinedBody: (store) => `Je bent in de Discord-server van ${store}, met de rollen die horen bij wat je kocht.`,
  openDiscord: "Discord openen",
  keepNote: "De rollen blijven zolang wat je kocht van jou is. Eindigt een lidmaatschap of wordt een aankoop volledig terugbetaald, dan worden ze bij de volgende controle weggehaald.",
  backToStore: (store) => `Terug naar ${store}`,
  notices: {
    declined: { title: "Er is niets veranderd", body: "Je zei nee op de pagina van Discord. Druk opnieuw op de knop wanneer je lid wilt worden." },
    none: { title: "Geen aankoop met toegang tot Discord", body: "Niets wat met dit adres is gekocht, hoort nu bij de Discord-server. Open je bestellingen via de e-mail naar het adres waarmee je betaalde, en gebruik daar de knop." },
    failed: { title: "Discord liet je nu niet binnen", body: "Er is niets veranderd. Probeer het over een paar minuten opnieuw. Gebeurt het weer, dan moet de eigenaar van de winkel misschien de instellingen van de server nakijken." },
    off: { title: "Deze winkel heeft geen Discord-server gekoppeld", body: "Er is niets veranderd. De eigenaar van de winkel kan je vertellen waar de community is." },
    expired: { title: "Dat duurde te lang", body: "Voor je veiligheid werkt de weg terug van Discord tien minuten. Druk opnieuw op de knop." },
  },
};

// European Portuguese: the courteous third person, as in lib/buyer-words/giving.ts.
const pt: DiscordWords = {
  joinButton: "Entrar no Discord",
  thanksNote: (store) => `Esta compra dá acesso ao servidor de Discord de ${store}. Carregue no botão, aceite na própria página do Discord e fica lá dentro, com os seus cargos.`,
  ordersNote: "Abre o servidor de Discord que acompanha a compra.",
  pageTitle: "Acesso ao Discord",
  joinedTitle: "Já está lá dentro",
  joinedBody: (store) => `Já está no servidor de Discord de ${store}, com os cargos que acompanham o que comprou.`,
  openDiscord: "Abrir o Discord",
  keepNote: "Os cargos mantêm-se enquanto o que comprou for seu. Quando uma assinatura termina ou uma compra é reembolsada na totalidade, são retirados na verificação seguinte.",
  backToStore: (store) => `Voltar a ${store}`,
  notices: {
    declined: { title: "Nada foi alterado", body: "Recusou na página do Discord. Carregue de novo no botão quando quiser entrar." },
    none: { title: "Nenhuma compra com acesso ao Discord", body: "Nada do que foi comprado com este endereço dá agora acesso ao servidor de Discord. Abra as suas encomendas a partir do email enviado para o endereço com que pagou e use o botão que lá encontra." },
    failed: { title: "O Discord não o deixou entrar de momento", body: "Nada foi alterado. Tente de novo dentro de alguns minutos. Se voltar a acontecer, o dono da loja poderá ter de verificar as definições do servidor." },
    off: { title: "Esta loja não tem um servidor de Discord ligado", body: "Nada foi alterado. O dono da loja pode dizer-lhe onde está a comunidade." },
    expired: { title: "Demorou demasiado", body: "Para sua segurança, o regresso do Discord funciona durante dez minutos. Carregue de novo no botão." },
  },
};

export const DISCORD_WORDS: Record<LanguageCode, DiscordWords> = { en, es, fr, de, it, nl, pt };

export function discordWords(language: unknown): DiscordWords {
  return DISCORD_WORDS[parseLanguage(language)];
}
