/** Private download renewal screens follow the store's seven buyer languages. */
import { parseLanguage, type LanguageCode } from "@/lib/store-language";

type RenewalWords = {
  title: string;
  intro: string;
  button: string;
  savedTitle: string;
  savedBody: string;
  sameSite: string;
  badForm: string;
  unreadable: string;
  incomplete: string;
  missingStore: string;
  invalid: string;
  tooOften: string;
  unavailable: string;
  notPaid: string;
};

const WORDS: Record<LanguageCode, RenewalWords> = {
  en: {
    sameSite: "This request must come from this site.",
    badForm: "Please use the download link's form.",
    unreadable: "This request could not be read.",
    incomplete: "This request is incomplete.",
    missingStore: "We could not find this store.",
    title: "Request a new download link",
    intro: "A new link can be emailed to the inbox used for this purchase.",
    button: "Email a new link",
    savedTitle: "Your request is saved",
    savedBody: "A new link will be emailed to the inbox used for this purchase when sending is available.",
    invalid: "This download link could not be checked.",
    tooOften: "Please wait before requesting another link.",
    unavailable: "A new link cannot be requested right now. Please try again later.",
    notPaid: "This purchase is no longer paid or has been refunded, so its download is closed.",
  },
  es: {
    sameSite: "Esta solicitud debe proceder de este sitio.",
    badForm: "Usa el formulario del enlace de descarga.",
    unreadable: "No hemos podido leer esta solicitud.",
    incomplete: "Esta solicitud está incompleta.",
    missingStore: "No hemos podido encontrar esta tienda.",
    title: "Solicita un nuevo enlace de descarga",
    intro: "Podemos enviar un nuevo enlace al email que usaste para esta compra.",
    button: "Enviar un nuevo enlace por email",
    savedTitle: "Tu solicitud está guardada",
    savedBody: "Enviaremos un nuevo enlace al email que usaste para esta compra cuando el envío esté disponible.",
    invalid: "No hemos podido comprobar este enlace de descarga.",
    tooOften: "Espera un poco antes de solicitar otro enlace.",
    unavailable: "Ahora no se puede solicitar un nuevo enlace. Inténtalo de nuevo más tarde.",
    notPaid: "Esta compra ya no está pagada o se ha reembolsado, por lo que la descarga está cerrada.",
  },
  fr: {
    sameSite: "Cette demande doit provenir de ce site.",
    badForm: "Veuillez utiliser le formulaire du lien de téléchargement.",
    unreadable: "Cette demande n’a pas pu être lue.",
    incomplete: "Cette demande est incomplète.",
    missingStore: "Cette boutique est introuvable.",
    title: "Demandez un nouveau lien de téléchargement",
    intro: "Un nouveau lien peut être envoyé à l’adresse email utilisée pour cet achat.",
    button: "Recevoir un nouveau lien par email",
    savedTitle: "Votre demande est enregistrée",
    savedBody: "Un nouveau lien sera envoyé à l’adresse email utilisée pour cet achat dès que l’envoi sera disponible.",
    invalid: "Ce lien de téléchargement n’a pas pu être vérifié.",
    tooOften: "Veuillez patienter avant de demander un autre lien.",
    unavailable: "Impossible de demander un nouveau lien pour le moment. Veuillez réessayer plus tard.",
    notPaid: "Cet achat n’est plus payé ou a été remboursé, le téléchargement est donc fermé.",
  },
  de: {
    sameSite: "Diese Anfrage muss von dieser Website kommen.",
    badForm: "Bitte nutze das Formular des Download-Links.",
    unreadable: "Diese Anfrage konnte nicht gelesen werden.",
    incomplete: "Diese Anfrage ist unvollständig.",
    missingStore: "Dieser Shop wurde nicht gefunden.",
    title: "Neuen Download-Link anfordern",
    intro: "Ein neuer Link kann an die E-Mail-Adresse gesendet werden, die du für diesen Kauf verwendet hast.",
    button: "Neuen Link per E-Mail senden",
    savedTitle: "Deine Anfrage ist gespeichert",
    savedBody: "Ein neuer Link wird an die E-Mail-Adresse für diesen Kauf gesendet, sobald der Versand verfügbar ist.",
    invalid: "Dieser Download-Link konnte nicht geprüft werden.",
    tooOften: "Bitte warte, bevor du einen weiteren Link anforderst.",
    unavailable: "Ein neuer Link kann gerade nicht angefordert werden. Bitte versuche es später erneut.",
    notPaid: "Dieser Kauf ist nicht mehr bezahlt oder wurde erstattet. Der Download ist deshalb geschlossen.",
  },
  it: {
    sameSite: "Questa richiesta deve provenire da questo sito.",
    badForm: "Usa il modulo del link per scaricare.",
    unreadable: "Non è stato possibile leggere questa richiesta.",
    incomplete: "Questa richiesta è incompleta.",
    missingStore: "Non è stato possibile trovare questo negozio.",
    title: "Richiedi un nuovo link per scaricare",
    intro: "Possiamo inviare un nuovo link all’indirizzo email usato per questo acquisto.",
    button: "Invia un nuovo link via email",
    savedTitle: "La tua richiesta è stata salvata",
    savedBody: "Un nuovo link sarà inviato all’indirizzo email usato per questo acquisto quando l’invio sarà disponibile.",
    invalid: "Non è stato possibile verificare questo link per scaricare.",
    tooOften: "Attendi prima di richiedere un altro link.",
    unavailable: "Al momento non è possibile richiedere un nuovo link. Riprova più tardi.",
    notPaid: "Questo acquisto non risulta più pagato o è stato rimborsato, quindi il download è chiuso.",
  },
  nl: {
    sameSite: "Dit verzoek moet van deze website komen.",
    badForm: "Gebruik het formulier van de downloadlink.",
    unreadable: "Dit verzoek kon niet worden gelezen.",
    incomplete: "Dit verzoek is onvolledig.",
    missingStore: "We konden deze winkel niet vinden.",
    title: "Vraag een nieuwe downloadlink aan",
    intro: "Een nieuwe link kan worden gemaild naar het adres dat je voor deze aankoop hebt gebruikt.",
    button: "Een nieuwe link e-mailen",
    savedTitle: "Je verzoek is opgeslagen",
    savedBody: "Een nieuwe link wordt gemaild naar het adres voor deze aankoop zodra verzenden beschikbaar is.",
    invalid: "Deze downloadlink kon niet worden gecontroleerd.",
    tooOften: "Wacht even voordat je nog een link aanvraagt.",
    unavailable: "Je kunt nu geen nieuwe link aanvragen. Probeer het later opnieuw.",
    notPaid: "Deze aankoop is niet meer betaald of is terugbetaald. De download is daarom gesloten.",
  },
  pt: {
    sameSite: "Este pedido tem de ser feito a partir deste site.",
    badForm: "Utilize o formulário da ligação para descarregar.",
    unreadable: "Não foi possível ler este pedido.",
    incomplete: "Este pedido está incompleto.",
    missingStore: "Não foi possível encontrar esta loja.",
    title: "Peça uma nova ligação para descarregar",
    intro: "Podemos enviar uma nova ligação para o email utilizado nesta compra.",
    button: "Enviar uma nova ligação por email",
    savedTitle: "O seu pedido foi guardado",
    savedBody: "Uma nova ligação será enviada para o email utilizado nesta compra quando o envio estiver disponível.",
    invalid: "Não foi possível verificar esta ligação para descarregar.",
    tooOften: "Aguarde antes de pedir outra ligação.",
    unavailable: "Não é possível pedir uma nova ligação neste momento. Tente novamente mais tarde.",
    notPaid: "Esta compra já não está paga ou foi reembolsada, por isso o ficheiro já não pode ser descarregado.",
  },
};

export function downloadRenewalWords(language: unknown): RenewalWords {
  return WORDS[parseLanguage(language)];
}
