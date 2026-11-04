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
  capacity: string;
  acceptanceUnknown: string;
  onHold: string;
  refused: string;
  notPaid: string;
};

const WORDS: Record<LanguageCode, RenewalWords> = {
  en: {
    acceptanceUnknown: "The previous email may have been sent, but acceptance could not be confirmed. Another email has not been scheduled. Contact the store for help.",
    onHold: "Your previous request is retained, but no further attempt is scheduled. Contact the store for help.",
    refused: "The previous email was refused. It is not scheduled to be sent again. Contact the store for help.",
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
    capacity: "There is no capacity for another pending download link request. Your request has not been saved, and no email has been scheduled. Contact the store for help.",
    notPaid: "This purchase is no longer paid or has been refunded, so its download is closed.",
  },
  es: {
    acceptanceUnknown: "El correo anterior puede haberse enviado, pero no se pudo confirmar su aceptación. No se ha programado otro correo. Contacta con la tienda.",
    onHold: "Tu solicitud anterior se conserva, pero no hay otro intento programado. Contacta con la tienda.",
    refused: "El correo anterior fue rechazado. No se ha programado otro envío. Contacta con la tienda.",
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
    capacity: "No hay capacidad para otra solicitud de enlace de descarga pendiente. Tu solicitud no se ha guardado y no se ha programado ningún email. Contacta con la tienda para obtener ayuda.",
    notPaid: "Esta compra ya no está pagada o se ha reembolsado, por lo que la descarga está cerrada.",
  },
  fr: {
    acceptanceUnknown: "Le courriel précédent a peut-être été envoyé, mais son acceptation n’a pas pu être confirmée. Aucun autre courriel n’est programmé. Contactez la boutique.",
    onHold: "Votre demande précédente est conservée, mais aucune nouvelle tentative n’est programmée. Contactez la boutique.",
    refused: "Le courriel précédent a été refusé. Aucun nouvel envoi n’est programmé. Contactez la boutique.",
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
    capacity: "La capacité disponible ne permet pas d’ajouter une demande de lien de téléchargement en attente. Votre demande n’a pas été enregistrée et aucun email n’a été programmé. Contactez la boutique pour obtenir de l’aide.",
    notPaid: "Cet achat n’est plus payé ou a été remboursé, le téléchargement est donc fermé.",
  },
  de: {
    acceptanceUnknown: "Die vorherige E-Mail wurde möglicherweise gesendet, ihre Annahme konnte aber nicht bestätigt werden. Eine weitere E-Mail ist nicht geplant. Bitte kontaktiere den Shop.",
    onHold: "Deine vorherige Anfrage wird aufbewahrt, aber ein weiterer Versuch ist nicht geplant. Bitte kontaktiere den Shop.",
    refused: "Die vorherige E-Mail wurde abgewiesen. Ein erneuter Versand ist nicht geplant. Bitte kontaktiere den Shop.",
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
    capacity: "Für eine weitere ausstehende Download-Link-Anfrage ist keine Kapazität verfügbar. Deine Anfrage wurde nicht gespeichert und es wurde keine E-Mail eingeplant. Bitte wende dich an den Shop.",
    notPaid: "Dieser Kauf ist nicht mehr bezahlt oder wurde erstattet. Der Download ist deshalb geschlossen.",
  },
  it: {
    acceptanceUnknown: "L’email precedente potrebbe essere stata inviata, ma non è stato possibile confermarne l’accettazione. Non è programmata un’altra email. Contatta il negozio.",
    onHold: "La richiesta precedente è conservata, ma non è programmato un altro tentativo. Contatta il negozio.",
    refused: "L’email precedente è stata rifiutata. Non è programmato un nuovo invio. Contatta il negozio.",
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
    capacity: "Non è disponibile capacità per un’altra richiesta di link per scaricare in attesa. La tua richiesta non è stata salvata e non è stata programmata alcuna email. Contatta il negozio per assistenza.",
    notPaid: "Questo acquisto non risulta più pagato o è stato rimborsato, quindi il download è chiuso.",
  },
  nl: {
    acceptanceUnknown: "De vorige e-mail is mogelijk verzonden, maar de acceptatie kon niet worden bevestigd. Er staat geen nieuwe e-mail gepland. Neem contact op met de winkel.",
    onHold: "Je vorige verzoek blijft bewaard, maar er staat geen nieuwe poging gepland. Neem contact op met de winkel.",
    refused: "De vorige e-mail is geweigerd. Er staat geen nieuwe verzending gepland. Neem contact op met de winkel.",
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
    capacity: "Er is geen capaciteit voor nog een openstaande aanvraag voor een downloadlink. Je verzoek is niet opgeslagen en er is geen e-mail ingepland. Neem contact op met de winkel voor hulp.",
    notPaid: "Deze aankoop is niet meer betaald of is terugbetaald. De download is daarom gesloten.",
  },
  pt: {
    acceptanceUnknown: "O email anterior pode ter sido enviado, mas não foi possível confirmar a aceitação. Não está programado outro email. Contacte a loja para obter ajuda.",
    onHold: "O seu pedido anterior está guardado, mas não está programada outra tentativa. Contacte a loja para obter ajuda.",
    refused: "O email anterior foi recusado. Não está programado um novo envio. Contacte a loja para obter ajuda.",
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
    capacity: "Não há capacidade para mais um pedido pendente de ligação para descarregar. O seu pedido não foi guardado e não foi programado nenhum email. Contacte a loja para obter ajuda.",
    notPaid: "Esta compra já não está paga ou foi reembolsada, por isso o ficheiro já não pode ser descarregado.",
  },
};

export function downloadRenewalWords(language: unknown): RenewalWords {
  return WORDS[parseLanguage(language)];
}
