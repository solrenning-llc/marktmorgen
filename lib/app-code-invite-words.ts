/**
 * The studio's quiet invitation to add an authenticator app's code as a
 * second step, for an account that logs in with passkeys and has no app
 * turned on (owner, C3-96 item 2, 04/11/2026).
 *
 * Why it matters, in the owner's words: someone who took over only the
 * email can log in with a link and ask to remove the passkey; the request
 * waits REMOVAL_DAYS (lib/passkeys.ts), and only a session with a valid
 * second step can press "Keep it" (lib/second-step-gate.ts mayKeepPasskey).
 * With the passkey alone, a lost or far-away device leaves the owner with
 * nothing to stop it; the app's code is a second, separate way to prove the
 * account is theirs.
 *
 * Shown discreetly, at most once per browser session: the flag lives in the
 * browser's sessionStorage (components/app-code-invite.tsx), never on our
 * servers. Whether to offer it is decided from the passkeys and the two-step
 * status the studio page already loads, so it costs no read of its own.
 *
 * The studio is in English; this one note speaks the person's browser
 * language when it is one a store can speak (lib/store-language.ts), and
 * English otherwise, in words written by hand like every buyer word
 * (lib/buyer-words/). No urgency, no fear: one plain reason and one link.
 *
 * Browser-safe.
 */
import { DEFAULT_LANGUAGE, type LanguageCode, isLanguage } from "@/lib/store-language";

export type AppCodeInviteWords = {
  /** The note's heading, which also names its region. */
  title: string;
  /** Why, in one plain sentence or two. */
  body: string;
  /** The link to the studio's Two-step login, saying where it goes. */
  link: string;
  /** The close button's accessible name. */
  close: string;
};

export const APP_CODE_INVITE_WORDS: Record<LanguageCode, AppCodeInviteWords> = {
  en: {
    title: "You can add an app code too",
    body: "You log in with a passkey. If someone ever gets into your email, a code from an app on your phone lets you prove the account is yours and stop them, even when your passkey is not with you.",
    link: "Add an app code",
    close: "Close this tip",
  },
  es: {
    title: "También puedes añadir un código de app",
    body: "Inicias sesión con una llave de acceso (passkey). Si alguien entra alguna vez en tu correo, un código de una app en tu teléfono te permite demostrar que la cuenta es tuya y detenerlo, aunque no tengas tu llave de acceso contigo.",
    link: "Añadir un código de app",
    close: "Cerrar este consejo",
  },
  fr: {
    title: "Vous pouvez aussi ajouter un code d’application",
    body: "Vous vous connectez avec une clé d’accès (passkey). Si quelqu’un accède un jour à votre e-mail, un code d’une application sur votre téléphone vous permet de prouver que le compte est à vous et de l’arrêter, même si votre clé d’accès n’est pas avec vous.",
    link: "Ajouter un code d’application",
    close: "Fermer ce conseil",
  },
  de: {
    title: "Sie können auch einen App-Code hinzufügen",
    body: "Sie melden sich mit einem Passkey an. Falls jemand einmal in Ihr E-Mail-Postfach gelangt, können Sie mit einem Code aus einer App auf Ihrem Telefon zeigen, dass das Konto Ihnen gehört, und die Person aufhalten, auch wenn Sie Ihren Passkey nicht dabeihaben.",
    link: "App-Code hinzufügen",
    close: "Diesen Hinweis schließen",
  },
  it: {
    title: "Puoi aggiungere anche un codice da app",
    body: "Accedi con una passkey. Se un giorno qualcuno entra nella tua email, un codice da un’app sul tuo telefono ti permette di dimostrare che l’account è tuo e di fermarlo, anche se non hai con te la passkey.",
    link: "Aggiungi un codice da app",
    close: "Chiudi questo consiglio",
  },
  nl: {
    title: "Je kunt ook een app-code toevoegen",
    body: "Je logt in met een passkey. Als iemand ooit in je e-mail komt, kun je met een code uit een app op je telefoon laten zien dat het account van jou is en diegene tegenhouden, ook als je je passkey niet bij je hebt.",
    link: "Een app-code toevoegen",
    close: "Deze tip sluiten",
  },
  pt: {
    title: "Também pode adicionar um código de app",
    body: "Entra com uma chave de acesso (passkey). Se um dia alguém entrar no seu e-mail, o código de um autenticador no seu telefone permite provar que a conta é sua e bloquear essa pessoa, mesmo sem a sua chave de acesso por perto.",
    link: "Adicionar um código de app",
    close: "Fechar esta dica",
  },
};

/** Where the link goes: the studio's Two-step login section (components/two-step-manager.tsx). */
export const APP_CODE_INVITE_HREF = "#two-step";

/**
 * Whether the studio offers the note at all: an account with at least one
 * passkey and no authenticator app turned on, whose session is not locked
 * (a locked session has its own notice and cannot add the app yet).
 */
export function showAppCodeInvite(account: { passkeys: number; appOn: boolean; locked: boolean }): boolean {
  return account.passkeys > 0 && !account.appOn && !account.locked;
}

/** The first of the browser's languages a store can speak ("pt-BR" is "pt"), or English. */
export function inviteLanguage(preferred: readonly string[] | undefined): LanguageCode {
  for (const tag of preferred ?? []) {
    const code = String(tag).toLowerCase().split("-")[0];
    if (isLanguage(code)) return code;
  }
  return DEFAULT_LANGUAGE;
}

/** The note's words in one language. */
export function appCodeInviteWords(language: LanguageCode): AppCodeInviteWords {
  return APP_CODE_INVITE_WORDS[language];
}
