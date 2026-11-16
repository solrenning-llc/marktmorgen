/**
 * The words of a store's cart (lib/cart-rules.ts), in every language a store
 * sells in. Browser-safe: the cart is kept and shown in the visitor's browser.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const S = " ";

const en = {
  add: "Add to cart",
  added: "In your cart: remove",
  full: (max: number) => `A cart holds up to ${max} products.`,
  open: (count: number) => `Cart, ${count} ${count === 1 ? "product" : "products"}`,
  title: "Your cart",
  remove: (title: string) => `Remove ${title}`,
  dealRow: (percent: number) => `${percent}% off for buying more`,
  dealNext: (more: number, percent: number) => `Add ${more} more to take ${percent}% off everything in your cart.`,
  dealHint: (min: number, percent: number) => `${percent}% off when you buy ${min} or more together.`,
  total: "Total",
  checkout: (total: string) => `Check out · ${total}`,
  /** The button when the prices could not be checked: no amount it cannot vouch for (Stripe's page shows the exact total). */
  checkoutUnpriced: "Check out",
  /** Said instead of the total when the cart's prices could not be read again. */
  unchecked: "We could not check the prices just now, so no total is shown. The payment page shows the exact total before you pay.",
  /** Said when products in the cart have not been checked at all (the first read, or one just added, failed): nothing can be paid for yet. */
  uncheckedSome: (count: number) =>
    count === 1
      ? "We could not check 1 product in your cart just now, so you cannot pay yet."
      : `We could not check ${count} products in your cart just now, so you cannot pay yet.`,
  /** The button beside either sentence above that reads the cart again. */
  retry: "Try again",
  /** Said instead of the cart when its store answered that it does not exist: no "Try again" and no checkout. */
  storeClosed: "This store is not taking orders right now, so nothing in your cart can be paid for here. Nothing was charged.",
  note: "You pay once, on Stripe's secure page. Each product is handed over exactly as if you had bought it on its own.",
  empty: "Your cart is empty.",
  gone: "Not available in a cart right now: buy it from its own page.",
  /** Products that cannot ship to the one country the rest of the cart ships to (lib/cart-shipping.ts): "A, B and C", how many, and that country. */
  apart: (titles: string, count: number, country: string) =>
    count === 1
      ? `${titles} cannot ship with the rest of your cart (shipping to: ${country}). Remove it to check out, and buy it from its own page.`
      : `${titles} cannot ship with the rest of your cart (shipping to: ${country}). Remove them to check out, and buy them from their own pages.`,
  /** Under "Ships to": the country the visitor seems to be in, when it is not one of them. */
  notTo: (country: string) => `${country} is not one of them.`,
  /** A cart holding both shipped products and products handed over online (lib/cart-shipping.ts, shipsWithOnline). */
  mixed: "Shipped products and products you get online cannot be paid for together in one cart. Remove one kind to check out, and buy the others separately.",
  /** A limited product in the cart with none left (lib/stock.ts): not in what is paid for. */
  soldOut: "Sold out. It is not in your total.",
  loading: "Checking the prices…",
  close: "Close",
  changed: "Something in your cart changed since you added it. Look it over and check out again.",
  error: "The payment page could not be opened. Nothing was charged. Try again in a moment.",
  // ---- A reminder of a cart left at checkout (lib/checkout-recovery.ts) ----
  leftTitle: "You left before paying for your cart",
  backToCart: "Back to your cart",
  remindNote: (store: string) => `Leave your email and ${store} sends you one reminder with your cart, in about an hour. One email. It does not add you to any list.`,
  willEmail: (store: string) => `${store} will email you once, with your cart. If you pay for it before then, no reminder is sent.`,
  mailSubject: (store: string) => `Your cart at ${store}`,
  mailLead: (titles: string, store: string) => `You put ${titles} in your cart at ${store} and did not finish paying, so nothing was charged.`,
  mailHere: "Your cart is here, ready to pay:",
  mailPrices: "What each costs today:",
  and: "and",
  suggestHead: "Often bought with these",
  suggestWhy: (n: number, title: string) => `${n} buyers of ${title} also bought it`,
  pickHead: "Goes well with your cart",
  pickWhy: (store: string, title: string) => `${store} picked it to go with ${title}`,
  bundleHead: "Sold together for less",
  bundleHolds: (held: string, more: number) => (more ? `Holds ${held} from your cart, and ${more} more ${more === 1 ? "product" : "products"}.` : `Holds ${held} from your cart.`),
  bundleSave: (amount: string) => `Your cart costs ${amount} less with it.`,
  swap: "Swap for it",
  swapFor: (title: string) => `Swap what it holds for ${title}`,
  addAll: (n: number) => `Add all ${n} to cart`,
  allIn: "All of these are in your cart",
  noRoom: (max: number) => `A cart holds up to ${max} products: add the ones you want one by one.`,
};

export type CartWords = typeof en;

const es: CartWords = {
  add: "Añadir al carrito",
  added: "En tu carrito: quitar",
  full: (max) => `Un carrito admite hasta ${max} productos.`,
  open: (count) => `Carrito, ${count} ${count === 1 ? "producto" : "productos"}`,
  title: "Tu carrito",
  remove: (title) => `Quitar ${title}`,
  dealRow: (percent) => `${percent}% de descuento por comprar más`,
  dealNext: (more, percent) => `Añade ${more} más y descuenta un ${percent}% de todo tu carrito.`,
  dealHint: (min, percent) => `${percent}% de descuento si compras ${min} o más juntos.`,
  total: "Total",
  checkout: (total) => `Pagar · ${total}`,
  /** The button when the prices could not be checked: no amount it cannot vouch for (Stripe's page shows the exact total). */
  checkoutUnpriced: "Pagar",
  /** Said instead of the total when the cart's prices could not be read again. */
  unchecked: "No pudimos comprobar los precios ahora, así que no se muestra ningún total. La página de pago muestra el total exacto antes de que pagues.",
  uncheckedSome: (count) =>
    count === 1
      ? "No pudimos comprobar 1 producto de tu carrito ahora, así que todavía no puedes pagar."
      : `No pudimos comprobar ${count} productos de tu carrito ahora, así que todavía no puedes pagar.`,
  retry: "Intentar de nuevo",
  storeClosed: "Esta tienda no está aceptando pedidos ahora, así que no se puede pagar nada de tu carrito aquí. No se cobró nada.",
  note: "Pagas una sola vez, en la página segura de Stripe. Cada producto se entrega igual que si lo compraras por separado.",
  empty: "Tu carrito está vacío.",
  gone: "No está disponible en un carrito ahora mismo: cómpralo desde su propia página.",
  apart: (titles, count, country) =>
    count === 1
      ? `No se puede enviar con el resto de tu carrito (país de envío: ${country}): ${titles}. Quítalo para pagar y cómpralo desde su propia página.`
      : `No se pueden enviar con el resto de tu carrito (país de envío: ${country}): ${titles}. Quítalos para pagar y cómpralos desde sus propias páginas.`,
  notTo: (country) => `${country} no está entre ellos.`,
  mixed: "Los productos que se envían y los que recibes en línea no se pueden pagar juntos en un carrito. Quita un tipo para pagar y compra los otros por separado.",
  soldOut: "Agotado. No está en tu total.",
  loading: "Comprobando los precios…",
  close: "Cerrar",
  changed: "Algo de tu carrito cambió desde que lo añadiste. Revísalo y vuelve a pagar.",
  error: "No se pudo abrir la página de pago. No se cobró nada. Inténtalo de nuevo en un momento.",
  leftTitle: "Te fuiste antes de pagar tu carrito",
  backToCart: "Volver a tu carrito",
  remindNote: (store) => `Deja tu email y ${store} te enviará un solo recordatorio con tu carrito, en una hora más o menos. Un solo email. No te añade a ninguna lista.`,
  willEmail: (store) => `${store} te escribirá una sola vez, con tu carrito. Si lo pagas antes, no se envía ningún recordatorio.`,
  mailSubject: (store) => `Tu carrito en ${store}`,
  mailLead: (titles, store) => `Pusiste ${titles} en tu carrito de ${store} y no terminaste de pagar, así que no se ha cobrado nada.`,
  mailHere: "Tu carrito está aquí, listo para pagar:",
  mailPrices: "Lo que cuesta cada uno hoy:",
  and: "y",
  suggestHead: "Se suelen comprar con estos",
  suggestWhy: (n, title) => `${n} compradores de ${title} también lo compraron`,
  pickHead: "Va bien con tu carrito",
  pickWhy: (store, title) => `${store} lo eligió para acompañar a ${title}`,
  bundleHead: "Juntos por menos",
  bundleHolds: (held, more) => (more ? `Incluye ${held} de tu carrito y ${more} ${more === 1 ? "producto" : "productos"} más.` : `Incluye ${held} de tu carrito.`),
  bundleSave: (amount) => `Tu carrito cuesta ${amount} menos con él.`,
  swap: "Cambiar por este",
  swapFor: (title) => `Cambiar lo que incluye por ${title}`,
  addAll: (n) => `Añadir los ${n} al carrito`,
  allIn: "Todos están en tu carrito",
  noRoom: (max) => `Un carrito admite hasta ${max} productos: añade uno a uno los que quieras.`,
};

const fr: CartWords = {
  add: "Ajouter au panier",
  added: `Dans votre panier${S}: retirer`,
  full: (max) => `Un panier contient jusqu'à ${max} produits.`,
  open: (count) => `Panier, ${count} ${count <= 1 ? "produit" : "produits"}`,
  title: "Votre panier",
  remove: (title) => `Retirer ${title}`,
  dealRow: (percent) => `${percent}${S}% de remise pour plusieurs achats`,
  dealNext: (more, percent) => `Ajoutez-en encore ${more} pour ${percent}${S}% de remise sur tout votre panier.`,
  dealHint: (min, percent) => `${percent}${S}% de remise dès ${min} achetés ensemble.`,
  total: "Total",
  checkout: (total) => `Payer · ${total}`,
  /** The button when the prices could not be checked: no amount it cannot vouch for (Stripe's page shows the exact total). */
  checkoutUnpriced: "Payer",
  /** Said instead of the total when the cart's prices could not be read again. */
  unchecked: "Nous n'avons pas pu vérifier les prix pour le moment, donc aucun total n'est affiché. La page de paiement affiche le total exact avant que vous payiez.",
  uncheckedSome: (count) =>
    count <= 1
      ? "Nous n'avons pas pu vérifier 1 produit de votre panier pour le moment, vous ne pouvez donc pas encore payer."
      : `Nous n'avons pas pu vérifier ${count} produits de votre panier pour le moment, vous ne pouvez donc pas encore payer.`,
  retry: "Réessayer",
  storeClosed: `Cette boutique ne prend pas de commandes pour le moment${S}: rien dans votre panier ne peut être payé ici. Rien n'a été débité.`,
  note: "Vous payez une seule fois, sur la page sécurisée de Stripe. Chaque produit est remis exactement comme s'il était acheté seul.",
  empty: "Votre panier est vide.",
  gone: `Pas disponible dans un panier pour l'instant${S}: achetez-le depuis sa propre page.`,
  apart: (titles, count, country) =>
    count === 1
      ? `Ne peut pas être livré avec le reste de votre panier (pays de livraison${S}: ${country})${S}: ${titles}. Retirez-le pour payer, et achetez-le depuis sa propre page.`
      : `Ne peuvent pas être livrés avec le reste de votre panier (pays de livraison${S}: ${country})${S}: ${titles}. Retirez-les pour payer, et achetez-les depuis leurs propres pages.`,
  notTo: (country) => `${country} n'en fait pas partie.`,
  mixed: `Les produits livrés et les produits reçus en ligne ne peuvent pas être payés ensemble dans un panier. Retirez-en un type pour payer, et achetez les autres à part.`,
  soldOut: `Épuisé. Il n'est pas compté dans votre total.`,
  loading: "Vérification des prix…",
  close: "Fermer",
  changed: "Quelque chose a changé dans votre panier depuis votre ajout. Vérifiez-le et payez de nouveau.",
  error: "La page de paiement n'a pas pu s'ouvrir. Rien n'a été débité. Réessayez dans un instant.",
  leftTitle: "Vous avez quitté la page avant de payer votre panier",
  backToCart: "Retour à votre panier",
  remindNote: (store) => `Laissez votre e-mail et ${store} vous enverra un seul rappel avec votre panier, dans une heure environ. Un seul e-mail. Il ne vous inscrit à aucune liste.`,
  willEmail: (store) => `${store} vous enverra un seul e-mail, avec votre panier. Si vous le payez d'ici là, aucun rappel n'est envoyé.`,
  mailSubject: (store) => `Votre panier chez ${store}`,
  mailLead: (titles, store) => `Vous avez mis ${titles} dans votre panier chez ${store} sans aller au bout du paiement, donc rien n'a été débité.`,
  mailHere: `Votre panier est ici, prêt à être payé${S}:`,
  mailPrices: `Le prix de chacun aujourd'hui${S}:`,
  and: "et",
  suggestHead: "Souvent achetés avec ceux-ci",
  suggestWhy: (n, title) => `${n}${S}acheteurs de ${title} l'ont aussi acheté`,
  pickHead: "Va bien avec votre panier",
  pickWhy: (store, title) => `${store} l'a choisi pour aller avec ${title}`,
  bundleHead: "Ensemble, pour moins cher",
  bundleHolds: (held, more) => (more ? `Contient ${held} de votre panier, et ${more} ${more === 1 ? "autre produit" : "autres produits"}.` : `Contient ${held} de votre panier.`),
  bundleSave: (amount) => `Votre panier coûte ${amount} de moins avec lui.`,
  swap: "Le prendre à la place",
  swapFor: (title) => `Remplacer ce qu'il contient par ${title}`,
  addAll: (n) => `Ajouter les ${n} au panier`,
  allIn: "Ils sont tous dans votre panier",
  noRoom: (max) => `Un panier contient jusqu'à ${max} produits${S}: ajoutez un à un ceux que vous voulez.`,
};

const de: CartWords = {
  add: "In den Warenkorb",
  added: "Im Warenkorb: entfernen",
  full: (max) => `Ein Warenkorb fasst bis zu ${max} Produkte.`,
  open: (count) => `Warenkorb, ${count} ${count === 1 ? "Produkt" : "Produkte"}`,
  title: "Ihr Warenkorb",
  remove: (title) => `${title} entfernen`,
  dealRow: (percent) => `${percent}${S}% Rabatt für mehrere`,
  dealNext: (more, percent) => `Noch ${more} hinzufügen und ${percent}${S}% auf den ganzen Warenkorb sparen.`,
  dealHint: (min, percent) => `${percent}${S}% Rabatt, wenn Sie ${min} oder mehr zusammen kaufen.`,
  total: "Gesamt",
  checkout: (total) => `Zur Kasse · ${total}`,
  /** The button when the prices could not be checked: no amount it cannot vouch for (Stripe's page shows the exact total). */
  checkoutUnpriced: "Zur Kasse",
  /** Said instead of the total when the cart's prices could not be read again. */
  unchecked: "Wir konnten die Preise gerade nicht prüfen, daher wird keine Summe angezeigt. Die Zahlungsseite zeigt die genaue Summe, bevor Sie bezahlen.",
  uncheckedSome: (count) =>
    count === 1
      ? "Wir konnten 1 Produkt in Ihrem Warenkorb gerade nicht prüfen, daher können Sie noch nicht bezahlen."
      : `Wir konnten ${count} Produkte in Ihrem Warenkorb gerade nicht prüfen, daher können Sie noch nicht bezahlen.`,
  retry: "Erneut versuchen",
  storeClosed: "Dieser Shop nimmt gerade keine Bestellungen an, daher kann hier nichts aus Ihrem Warenkorb bezahlt werden. Es wurde nichts abgebucht.",
  note: "Sie bezahlen einmal, auf der sicheren Seite von Stripe. Jedes Produkt wird genau so übergeben, als hätten Sie es einzeln gekauft.",
  empty: "Ihr Warenkorb ist leer.",
  gone: "Gerade nicht im Warenkorb erhältlich: Kaufen Sie es auf seiner eigenen Seite.",
  apart: (titles, count, country) =>
    count === 1
      ? `Kann nicht mit dem Rest Ihres Warenkorbs geliefert werden (Lieferland: ${country}): ${titles}. Entfernen Sie es, um zu bezahlen, und kaufen Sie es auf seiner eigenen Seite.`
      : `Können nicht mit dem Rest Ihres Warenkorbs geliefert werden (Lieferland: ${country}): ${titles}. Entfernen Sie sie, um zu bezahlen, und kaufen Sie sie auf ihren eigenen Seiten.`,
  notTo: (country) => `${country} gehört nicht dazu.`,
  mixed: "Versandprodukte und Online-Produkte können nicht zusammen in einem Warenkorb bezahlt werden. Entfernen Sie eine Art, um zu bezahlen, und kaufen Sie die anderen einzeln.",
  soldOut: "Ausverkauft. Es ist nicht in Ihrer Summe.",
  loading: "Preise werden geprüft…",
  close: "Schließen",
  changed: "Seit dem Hinzufügen hat sich etwas in Ihrem Warenkorb geändert. Prüfen Sie ihn und gehen Sie erneut zur Kasse.",
  error: "Die Zahlungsseite konnte nicht geöffnet werden. Es wurde nichts berechnet. Versuchen Sie es gleich noch einmal.",
  leftTitle: "Sie haben die Seite verlassen, bevor Sie Ihren Warenkorb bezahlt haben",
  backToCart: "Zurück zu Ihrem Warenkorb",
  remindNote: (store) => `Hinterlassen Sie Ihre E-Mail-Adresse, und ${store} schickt Ihnen in etwa einer Stunde eine einzige Erinnerung mit Ihrem Warenkorb. Eine E-Mail. Sie werden in keine Liste aufgenommen.`,
  willEmail: (store) => `${store} schickt Ihnen einmalig eine E-Mail mit Ihrem Warenkorb. Wenn Sie ihn vorher bezahlen, wird keine Erinnerung gesendet.`,
  mailSubject: (store) => `Ihr Warenkorb bei ${store}`,
  mailLead: (titles, store) => `Sie haben ${titles} bei ${store} in den Warenkorb gelegt und nicht fertig bezahlt, daher wurde nichts berechnet.`,
  mailHere: "Ihr Warenkorb ist hier, bereit zum Bezahlen:",
  mailPrices: "Was jedes heute kostet:",
  and: "und",
  suggestHead: "Oft zusammen damit gekauft",
  suggestWhy: (n, title) => `${n} Käufer von ${title} haben es auch gekauft`,
  pickHead: "Passt gut zu Ihrem Warenkorb",
  pickWhy: (store, title) => `Von ${store} ausgewählt, passend zu ${title}`,
  bundleHead: "Zusammen günstiger",
  bundleHolds: (held, more) => (more ? `Enthält ${held} aus Ihrem Warenkorb und ${more} ${more === 1 ? "weiteres Produkt" : "weitere Produkte"}.` : `Enthält ${held} aus Ihrem Warenkorb.`),
  bundleSave: (amount) => `Damit kostet Ihr Warenkorb ${amount} weniger.`,
  swap: "Dagegen tauschen",
  swapFor: (title) => `Was es enthält gegen ${title} tauschen`,
  addAll: (n) => `Alle ${n} in den Warenkorb`,
  allIn: "Alle sind in Ihrem Warenkorb",
  noRoom: (max) => `Ein Warenkorb fasst bis zu ${max} Produkte: Legen Sie die gewünschten einzeln hinein.`,
};

const it: CartWords = {
  add: "Aggiungi al carrello",
  added: "Nel carrello: rimuovi",
  full: (max) => `Un carrello contiene fino a ${max} prodotti.`,
  open: (count) => `Carrello, ${count} ${count === 1 ? "prodotto" : "prodotti"}`,
  title: "Il tuo carrello",
  remove: (title) => `Rimuovi ${title}`,
  dealRow: (percent) => `${percent}% di sconto per l'acquisto di più prodotti`,
  dealNext: (more, percent) => `Aggiungine altri ${more} per il ${percent}% di sconto su tutto il carrello.`,
  dealHint: (min, percent) => `${percent}% di sconto comprandone ${min} o più insieme.`,
  total: "Totale",
  checkout: (total) => `Paga · ${total}`,
  /** The button when the prices could not be checked: no amount it cannot vouch for (Stripe's page shows the exact total). */
  checkoutUnpriced: "Paga",
  /** Said instead of the total when the cart's prices could not be read again. */
  unchecked: "Non è stato possibile controllare i prezzi in questo momento, quindi non è mostrato alcun totale. La pagina di pagamento mostra il totale esatto prima che tu paghi.",
  uncheckedSome: (count) =>
    count === 1
      ? "Non è stato possibile controllare 1 prodotto del tuo carrello in questo momento, quindi non puoi ancora pagare."
      : `Non è stato possibile controllare ${count} prodotti del tuo carrello in questo momento, quindi non puoi ancora pagare.`,
  retry: "Riprova",
  storeClosed: "Questo negozio non accetta ordini in questo momento, quindi qui non si può pagare nulla del tuo carrello. Non è stato addebitato nulla.",
  note: "Paghi una volta sola, sulla pagina sicura di Stripe. Ogni prodotto viene consegnato esattamente come se lo comprassi da solo.",
  empty: "Il tuo carrello è vuoto.",
  gone: "Al momento non disponibile in un carrello: compralo dalla sua pagina.",
  apart: (titles, count, country) =>
    count === 1
      ? `Non può essere spedito con il resto del carrello (paese di spedizione: ${country}): ${titles}. Toglilo per pagare e compralo dalla sua pagina.`
      : `Non possono essere spediti con il resto del carrello (paese di spedizione: ${country}): ${titles}. Toglili per pagare e comprali dalle loro pagine.`,
  notTo: (country) => `${country} non è tra questi.`,
  mixed: "I prodotti spediti e quelli che ricevi online non si possono pagare insieme in un carrello. Togli un tipo per pagare e compra gli altri a parte.",
  soldOut: "Esaurito. Non è nel tuo totale.",
  loading: "Controllo dei prezzi…",
  close: "Chiudi",
  changed: "Qualcosa nel tuo carrello è cambiato da quando l'hai aggiunto. Controllalo e paga di nuovo.",
  error: "Non è stato possibile aprire la pagina di pagamento. Non è stato addebitato nulla. Riprova tra poco.",
  leftTitle: "Hai lasciato la pagina prima di pagare il tuo carrello",
  backToCart: "Torna al tuo carrello",
  remindNote: (store) => `Lascia la tua email e ${store} ti invierà un solo promemoria con il tuo carrello, tra circa un'ora. Una sola email. Non ti aggiunge a nessuna lista.`,
  willEmail: (store) => `${store} ti scriverà una sola volta, con il tuo carrello. Se lo paghi prima, non viene inviato nessun promemoria.`,
  mailSubject: (store) => `Il tuo carrello su ${store}`,
  mailLead: (titles, store) => `Hai messo ${titles} nel tuo carrello su ${store} e non hai finito di pagare, quindi non è stato addebitato nulla.`,
  mailHere: "Il tuo carrello è qui, pronto da pagare:",
  mailPrices: "Quanto costa ciascuno oggi:",
  and: "e",
  suggestHead: "Spesso acquistati insieme a questi",
  suggestWhy: (n, title) => `${n} acquirenti di ${title} lo hanno acquistato anche`,
  pickHead: "Si abbina bene al tuo carrello",
  pickWhy: (store, title) => `Scelto da ${store} da abbinare a ${title}`,
  bundleHead: "Insieme, a meno",
  bundleHolds: (held, more) => (more ? `Contiene ${held} del tuo carrello e altri ${more} ${more === 1 ? "prodotto" : "prodotti"}.` : `Contiene ${held} del tuo carrello.`),
  bundleSave: (amount) => `Con questo il tuo carrello costa ${amount} in meno.`,
  swap: "Sostituisci con questo",
  swapFor: (title) => `Sostituisci ciò che contiene con ${title}`,
  addAll: (n) => `Aggiungi tutti e ${n} al carrello`,
  allIn: "Sono tutti nel tuo carrello",
  noRoom: (max) => `Un carrello contiene fino a ${max} prodotti: aggiungi uno alla volta quelli che vuoi.`,
};

const nl: CartWords = {
  add: "In winkelwagen",
  added: "In je winkelwagen: verwijderen",
  full: (max) => `Een winkelwagen bevat tot ${max} producten.`,
  open: (count) => `Winkelwagen, ${count} ${count === 1 ? "product" : "producten"}`,
  title: "Je winkelwagen",
  remove: (title) => `${title} verwijderen`,
  dealRow: (percent) => `${percent}% korting voor meer tegelijk`,
  dealNext: (more, percent) => `Voeg er nog ${more} toe voor ${percent}% korting op je hele winkelwagen.`,
  dealHint: (min, percent) => `${percent}% korting als je er ${min} of meer samen koopt.`,
  total: "Totaal",
  checkout: (total) => `Afrekenen · ${total}`,
  /** The button when the prices could not be checked: no amount it cannot vouch for (Stripe's page shows the exact total). */
  checkoutUnpriced: "Afrekenen",
  /** Said instead of the total when the cart's prices could not be read again. */
  unchecked: "We konden de prijzen nu niet controleren, dus er wordt geen totaal getoond. De betaalpagina toont het exacte totaal voordat je betaalt.",
  uncheckedSome: (count) =>
    count === 1
      ? "We konden 1 product in je winkelwagen nu niet controleren, dus je kunt nog niet betalen."
      : `We konden ${count} producten in je winkelwagen nu niet controleren, dus je kunt nog niet betalen.`,
  retry: "Opnieuw proberen",
  storeClosed: "Deze winkel neemt nu geen bestellingen aan, dus niets in je winkelwagen kan hier worden betaald. Er is niets afgeschreven.",
  note: "Je betaalt één keer, op de beveiligde pagina van Stripe. Elk product wordt precies zo geleverd als wanneer je het los koopt.",
  empty: "Je winkelwagen is leeg.",
  gone: "Nu niet beschikbaar in een winkelwagen: koop het op zijn eigen pagina.",
  apart: (titles, count, country) =>
    count === 1
      ? `Kan niet met de rest van je winkelwagen worden verzonden (verzendland: ${country}): ${titles}. Haal het eruit om te betalen en koop het op zijn eigen pagina.`
      : `Kunnen niet met de rest van je winkelwagen worden verzonden (verzendland: ${country}): ${titles}. Haal ze eruit om te betalen en koop ze op hun eigen pagina's.`,
  notTo: (country) => `${country} hoort er niet bij.`,
  mixed: "Producten die worden verzonden en producten die je online krijgt, kunnen niet samen in één winkelwagen worden betaald. Haal één soort eruit om te betalen en koop de andere apart.",
  soldOut: "Uitverkocht. Het telt niet mee in je totaal.",
  loading: "Prijzen controleren…",
  close: "Sluiten",
  changed: "Er is iets in je winkelwagen veranderd sinds je het toevoegde. Bekijk het en reken opnieuw af.",
  error: "De betaalpagina kon niet worden geopend. Er is niets afgeschreven. Probeer het zo opnieuw.",
  leftTitle: "Je ging weg voordat je je winkelwagen had betaald",
  backToCart: "Terug naar je winkelwagen",
  remindNote: (store) => `Laat je e-mailadres achter en ${store} stuurt je over ongeveer een uur één herinnering met je winkelwagen. Eén e-mail. Je wordt aan geen enkele lijst toegevoegd.`,
  willEmail: (store) => `${store} mailt je één keer, met je winkelwagen. Betaal je hem voor die tijd, dan wordt er geen herinnering gestuurd.`,
  mailSubject: (store) => `Je winkelwagen bij ${store}`,
  mailLead: (titles, store) => `Je legde ${titles} in je winkelwagen bij ${store} en rekende niet af, dus er is niets afgeschreven.`,
  mailHere: "Je winkelwagen staat hier klaar om af te rekenen:",
  mailPrices: "Wat elk vandaag kost:",
  and: "en",
  suggestHead: "Vaak samen hiermee gekocht",
  suggestWhy: (n, title) => `${n} kopers van ${title} kochten het ook`,
  pickHead: "Past goed bij je winkelwagen",
  pickWhy: (store, title) => `Door ${store} gekozen bij ${title}`,
  bundleHead: "Samen voor minder",
  bundleHolds: (held, more) => (more ? `Bevat ${held} uit je winkelwagen, en nog ${more} ${more === 1 ? "product" : "producten"}.` : `Bevat ${held} uit je winkelwagen.`),
  bundleSave: (amount) => `Je winkelwagen kost er ${amount} minder mee.`,
  swap: "Hiervoor ruilen",
  swapFor: (title) => `Ruil wat het bevat voor ${title}`,
  addAll: (n) => `Alle ${n} in winkelwagen`,
  allIn: "Ze zitten allemaal in je winkelwagen",
  noRoom: (max) => `Een winkelwagen bevat tot ${max} producten: voeg de producten die je wilt een voor een toe.`,
};

const pt: CartWords = {
  add: "Adicionar ao carrinho",
  added: "No seu carrinho: remover",
  full: (max) => `Um carrinho leva até ${max} produtos.`,
  open: (count) => `Carrinho, ${count} ${count === 1 ? "produto" : "produtos"}`,
  title: "O seu carrinho",
  remove: (title) => `Remover ${title}`,
  dealRow: (percent) => `${percent}% de desconto por comprar mais`,
  dealNext: (more, percent) => `Adicione mais ${more} e tenha ${percent}% de desconto em todo o carrinho.`,
  dealHint: (min, percent) => `${percent}% de desconto ao comprar ${min} ou mais em conjunto.`,
  total: "Total",
  checkout: (total) => `Pagar · ${total}`,
  /** The button when the prices could not be checked: no amount it cannot vouch for (Stripe's page shows the exact total). */
  checkoutUnpriced: "Pagar",
  /** Said instead of the total when the cart's prices could not be read again. */
  unchecked: "Não foi possível verificar os preços agora, por isso nenhum total é mostrado. A página de pagamento mostra o total exato antes de pagar.",
  uncheckedSome: (count) =>
    count === 1
      ? "Não foi possível verificar 1 produto do seu carrinho agora, por isso ainda não é possível pagar."
      : `Não foi possível verificar ${count} produtos do seu carrinho agora, por isso ainda não é possível pagar.`,
  retry: "Tentar novamente",
  storeClosed: "Esta loja não está a aceitar pedidos agora, por isso nada no seu carrinho pode ser pago aqui. Nada foi cobrado.",
  note: "Paga uma única vez, na página segura da Stripe. Cada produto é entregue exatamente como se o comprasse em separado.",
  empty: "O seu carrinho está vazio.",
  gone: "Não está disponível num carrinho neste momento: compre-o na sua própria página.",
  apart: (titles, count, country) =>
    count === 1
      ? `Não pode ser enviado com o resto do carrinho (país de envio: ${country}): ${titles}. Retire-o para pagar e compre-o na sua própria página.`
      : `Não podem ser enviados com o resto do carrinho (país de envio: ${country}): ${titles}. Retire-os para pagar e compre-os nas suas próprias páginas.`,
  notTo: (country) => `${country} não está entre eles.`,
  mixed: "Os produtos enviados e os produtos que recebe online não podem ser pagos juntos num carrinho. Retire um dos tipos para pagar e compre os outros à parte.",
  soldOut: "Esgotado. Não está no seu total.",
  loading: "A verificar os preços…",
  close: "Fechar",
  changed: "Algo no seu carrinho mudou desde que o adicionou. Reveja-o e pague novamente.",
  error: "Não foi possível abrir a página de pagamento. Nada foi cobrado. Tente novamente daqui a pouco.",
  leftTitle: "Saiu antes de pagar o seu carrinho",
  backToCart: "Voltar ao seu carrinho",
  remindNote: (store) => `Deixe o seu email e ${store} envia-lhe um único lembrete com o seu carrinho, daqui a cerca de uma hora. Um único email. Não o adiciona a nenhuma lista.`,
  willEmail: (store) => `${store} vai enviar-lhe um único email, com o seu carrinho. Se o pagar antes disso, não é enviado nenhum lembrete.`,
  mailSubject: (store) => `O seu carrinho em ${store}`,
  mailLead: (titles, store) => `Colocou ${titles} no seu carrinho em ${store} e não terminou o pagamento, por isso nada foi cobrado.`,
  mailHere: "O seu carrinho está aqui, pronto a pagar:",
  mailPrices: "Quanto custa cada um hoje:",
  and: "e",
  suggestHead: "Muitas vezes comprados com estes",
  suggestWhy: (n, title) => `${n} compradores de ${title} também o compraram`,
  pickHead: "Combina bem com o seu carrinho",
  pickWhy: (store, title) => `Escolhido por ${store} para acompanhar ${title}`,
  bundleHead: "Juntos por menos",
  bundleHolds: (held, more) => (more ? `Inclui ${held} do seu carrinho e mais ${more} ${more === 1 ? "produto" : "produtos"}.` : `Inclui ${held} do seu carrinho.`),
  bundleSave: (amount) => `Com ele, o seu carrinho custa ${amount} a menos.`,
  swap: "Trocar por este",
  swapFor: (title) => `Trocar o que ele inclui por ${title}`,
  addAll: (n) => `Adicionar os ${n} ao carrinho`,
  allIn: "Estão todos no seu carrinho",
  noRoom: (max) => `Um carrinho leva até ${max} produtos: adicione um a um os que quiser.`,
};

export const CART_WORDS: Record<LanguageCode, CartWords> = { en, es, fr, de, it, nl, pt };

export function cartWords(language: unknown): CartWords {
  return CART_WORDS[parseLanguage(language)];
}
