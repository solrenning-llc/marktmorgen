/**
 * The words around an approved affiliate's own tools on the store's affiliate
 * page (app/[handle]/affiliates), in each of the store's languages
 * (lib/store-language.ts): the panel that makes a link for one product, post
 * or ad (components/affiliate-campaign-links.tsx) and the table of commission
 * by campaign and post (components/affiliate-promotion-results.tsx).
 *
 * Counts and amounts arrive already written in the store's language; a
 * sentence here only places them. The share text is the affiliate's own
 * disclosure that they earn from the link, so every language says exactly
 * that: an affiliate link, and a commission when someone buys through it.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

/** A space that does not break, before French ":", "?", "!", ";". */
const S = " ";

const en = {
  linksSummary: "Create a link for a product, post or ad",
  linksIntro:
    "Keep your affiliate code on the link and name each campaign and post variant. These labels appear with recorded commissions when available. A link does not guarantee attribution: consent, program terms and the buyer's checkout still apply. If the creator assigned you a coupon, it is an alternative when cookies are declined. Include a clear commission disclosure wherever you share.",
  product: "Product",
  productsLoaded: (most: number) => `Published commission-earning products already loaded on this page, up to ${most}. This is not the entire catalog.`,
  /** What a network's share box is handed: the product's title and the disclosure. */
  shareTitle: (title: string) => `${title}. Affiliate link: I earn a commission if you buy through it.`,
  resultsHead: "Your posts and campaign links",
  resultsWaiting: "Campaign earnings wait until the invoice and refund readings are complete.",
  resultsIntro:
    "Recorded checkout or subscription campaign labels, not a reconstructed journey. Older or untagged purchases remain unlabeled. Records are purchases and renewals, not unique buyers or clicks. Commission is after recorded refunds, before payout.",
  resultsRegion: "Commission by campaign and post",
  channel: "Channel",
  campaign: "Campaign",
  postVariant: "Post / variant",
  paidRecords: "Paid records",
  commission: "Commission",
  unlabeled: "Unlabeled",
  showing: (shown: string, all: string) =>
    `Showing ${shown} of ${all} campaign groups. Currencies remain separate. Bonuses, partner shares and second-tier earnings stay in the earnings list below.`,
};

export type AffiliateToolWords = typeof en;

const es: AffiliateToolWords = {
  linksSummary: "Crea un enlace para un producto, una publicación o un anuncio",
  linksIntro:
    "Mantén tu código de afiliado en el enlace y ponle nombre a cada campaña y a cada variante de publicación. Estas etiquetas aparecen junto a las comisiones registradas cuando están disponibles. Un enlace no garantiza la atribución: el consentimiento, las condiciones del programa y el pago del comprador siguen aplicándose. Si el creador te asignó un cupón, es una alternativa cuando se rechazan las cookies. Incluye un aviso claro de que ganas una comisión dondequiera que compartas.",
  product: "Producto",
  productsLoaded: (most) => `Productos publicados que generan comisión y que ya están cargados en esta página, hasta ${most}. No es el catálogo completo.`,
  shareTitle: (title) => `${title}. Enlace de afiliado: gano una comisión si compras a través de él.`,
  resultsHead: "Tus publicaciones y enlaces de campaña",
  resultsWaiting: "Las ganancias por campaña esperan hasta que se completen las lecturas de facturas y reembolsos.",
  resultsIntro:
    "Etiquetas de campaña registradas en el pago o en la suscripción, no un recorrido reconstruido. Las compras más antiguas o sin etiquetar siguen sin etiqueta. Los registros son compras y renovaciones, no compradores únicos ni clics. La comisión es después de los reembolsos registrados y antes del pago.",
  resultsRegion: "Comisión por campaña y publicación",
  channel: "Canal",
  campaign: "Campaña",
  postVariant: "Publicación / variante",
  paidRecords: "Registros pagados",
  commission: "Comisión",
  unlabeled: "Sin etiqueta",
  showing: (shown, all) =>
    `Se muestran ${shown} de ${all} grupos de campaña. Las monedas se mantienen separadas. Los bonos, las participaciones de socios y las ganancias de segundo nivel siguen en la lista de ganancias de abajo.`,
};

const fr: AffiliateToolWords = {
  linksSummary: "Créer un lien pour un produit, une publication ou une annonce",
  linksIntro: `Gardez votre code d'affilié sur le lien et nommez chaque campagne et chaque variante de publication. Ces libellés apparaissent avec les commissions enregistrées lorsqu'elles sont disponibles. Un lien ne garantit pas l'attribution${S}: le consentement, les conditions du programme et le paiement de l'acheteur s'appliquent toujours. Si le créateur vous a attribué un code promo, c'est une solution de rechange lorsque les cookies sont refusés. Indiquez clairement que vous touchez une commission partout où vous partagez.`,
  product: "Produit",
  productsLoaded: (most) => `Produits publiés qui rapportent une commission, déjà chargés sur cette page, jusqu'à ${most}. Ce n'est pas tout le catalogue.`,
  shareTitle: (title) => `${title}. Lien d'affilié${S}: je touche une commission si vous achetez par ce lien.`,
  resultsHead: "Vos publications et liens de campagne",
  resultsWaiting: "Les gains par campagne attendent que la lecture des factures et des remboursements soit terminée.",
  resultsIntro:
    "Libellés de campagne enregistrés au paiement ou à l'abonnement, pas un parcours reconstitué. Les achats plus anciens ou sans libellé restent sans libellé. Les enregistrements sont des achats et des renouvellements, pas des acheteurs uniques ni des clics. La commission est comptée après les remboursements enregistrés, avant le versement.",
  resultsRegion: "Commission par campagne et publication",
  channel: "Canal",
  campaign: "Campagne",
  postVariant: "Publication / variante",
  paidRecords: "Enregistrements payés",
  commission: "Commission",
  unlabeled: "Sans libellé",
  showing: (shown, all) =>
    `${shown} groupes de campagne affichés sur ${all}. Les devises restent séparées. Les primes, les parts de partenaire et les gains de second niveau restent dans la liste des gains ci-dessous.`,
};

const de: AffiliateToolWords = {
  linksSummary: "Einen Link für ein Produkt, einen Beitrag oder eine Anzeige erstellen",
  linksIntro:
    "Behalten Sie Ihren Affiliate-Code im Link und benennen Sie jede Kampagne und jede Beitragsvariante. Diese Bezeichnungen erscheinen bei den erfassten Provisionen, sofern verfügbar. Ein Link garantiert keine Zuordnung: Einwilligung, Programmbedingungen und der Bezahlvorgang des Käufers gelten weiterhin. Wenn der Creator Ihnen einen Gutscheincode zugewiesen hat, ist er eine Alternative, wenn Cookies abgelehnt werden. Weisen Sie überall, wo Sie teilen, deutlich darauf hin, dass Sie eine Provision erhalten.",
  product: "Produkt",
  productsLoaded: (most) => `Veröffentlichte Produkte mit Provision, die bereits auf dieser Seite geladen sind, bis zu ${most}. Das ist nicht der gesamte Katalog.`,
  shareTitle: (title) => `${title}. Affiliate-Link: Ich erhalte eine Provision, wenn über diesen Link gekauft wird.`,
  resultsHead: "Ihre Beiträge und Kampagnenlinks",
  resultsWaiting: "Die Einnahmen nach Kampagne erscheinen erst, wenn Rechnungen und Erstattungen vollständig gelesen sind.",
  resultsIntro:
    "Beim Bezahlen oder beim Abonnement erfasste Kampagnenbezeichnungen, kein nachgebildeter Weg des Käufers. Ältere oder nicht markierte Käufe bleiben ohne Bezeichnung. Einträge sind Käufe und Verlängerungen, keine einzelnen Käufer oder Klicks. Die Provision gilt nach erfassten Erstattungen und vor der Auszahlung.",
  resultsRegion: "Provision nach Kampagne und Beitrag",
  channel: "Kanal",
  campaign: "Kampagne",
  postVariant: "Beitrag / Variante",
  paidRecords: "Bezahlte Einträge",
  commission: "Provision",
  unlabeled: "Ohne Bezeichnung",
  showing: (shown, all) =>
    `${shown} von ${all} Kampagnengruppen angezeigt. Währungen bleiben getrennt. Boni, Partneranteile und Einnahmen aus der zweiten Stufe stehen weiter unten in der Liste der Einnahmen.`,
};

const it: AffiliateToolWords = {
  linksSummary: "Crea un link per un prodotto, un post o un annuncio",
  linksIntro:
    "Tieni il tuo codice di affiliato nel link e dai un nome a ogni campagna e a ogni variante di post. Queste etichette compaiono accanto alle commissioni registrate, quando disponibili. Un link non garantisce l'attribuzione: il consenso, le condizioni del programma e il pagamento dell'acquirente restano validi. Se il creator ti ha assegnato un codice sconto, è un'alternativa quando i cookie vengono rifiutati. Indica chiaramente che guadagni una commissione ovunque condividi.",
  product: "Prodotto",
  productsLoaded: (most) => `Prodotti pubblicati che fanno guadagnare una commissione, già caricati in questa pagina, fino a ${most}. Non è l'intero catalogo.`,
  shareTitle: (title) => `${title}. Link di affiliazione: guadagno una commissione se acquisti tramite questo link.`,
  resultsHead: "I tuoi post e link di campagna",
  resultsWaiting: "I guadagni per campagna restano in attesa finché la lettura di fatture e rimborsi non è completa.",
  resultsIntro:
    "Etichette di campagna registrate al pagamento o all'abbonamento, non un percorso ricostruito. Gli acquisti più vecchi o senza etichetta restano senza etichetta. Le voci sono acquisti e rinnovi, non acquirenti unici né clic. La commissione è al netto dei rimborsi registrati, prima del pagamento.",
  resultsRegion: "Commissione per campagna e post",
  channel: "Canale",
  campaign: "Campagna",
  postVariant: "Post / variante",
  paidRecords: "Voci pagate",
  commission: "Commissione",
  unlabeled: "Senza etichetta",
  showing: (shown, all) =>
    `Sono mostrati ${shown} di ${all} gruppi di campagne. Le valute restano separate. Premi, quote da partner e guadagni di secondo livello restano nell'elenco dei guadagni qui sotto.`,
};

const nl: AffiliateToolWords = {
  linksSummary: "Maak een link voor een product, bericht of advertentie",
  linksIntro:
    "Houd je affiliatecode in de link en geef elke campagne en elke berichtvariant een naam. Deze labels verschijnen bij geregistreerde commissies als die beschikbaar zijn. Een link garandeert geen toekenning: toestemming, de programmavoorwaarden en het afrekenen door de koper blijven gelden. Als de maker je een kortingscode heeft gegeven, is die een alternatief wanneer cookies worden geweigerd. Vermeld overal waar je deelt duidelijk dat je commissie krijgt.",
  product: "Product",
  productsLoaded: (most) => `Gepubliceerde producten die commissie opleveren en al op deze pagina zijn geladen, tot ${most}. Dit is niet de hele catalogus.`,
  shareTitle: (title) => `${title}. Affiliatelink: ik krijg commissie als je via deze link koopt.`,
  resultsHead: "Je berichten en campagnelinks",
  resultsWaiting: "De opbrengst per campagne wacht tot facturen en terugbetalingen volledig zijn gelezen.",
  resultsIntro:
    "Geregistreerde campagnelabels bij het afrekenen of het abonnement, geen gereconstrueerde route. Oudere of niet-gelabelde aankopen blijven zonder label. Registraties zijn aankopen en verlengingen, geen unieke kopers of klikken. Commissie is na geregistreerde terugbetalingen, vóór uitbetaling.",
  resultsRegion: "Commissie per campagne en bericht",
  channel: "Kanaal",
  campaign: "Campagne",
  postVariant: "Bericht / variant",
  paidRecords: "Betaalde registraties",
  commission: "Commissie",
  unlabeled: "Zonder label",
  showing: (shown, all) =>
    `${shown} van ${all} campagnegroepen getoond. Valuta blijven gescheiden. Premies, partneraandelen en opbrengsten uit het tweede niveau staan in de lijst met opbrengsten hieronder.`,
};

const pt: AffiliateToolWords = {
  linksSummary: "Criar uma ligação para um produto, uma publicação ou um anúncio",
  linksIntro:
    "Mantenha o seu código de afiliado na ligação e dê um nome a cada campanha e a cada variante de publicação. Estas etiquetas aparecem junto das comissões registadas, quando disponíveis. Uma ligação não garante a atribuição: o consentimento, as condições do programa e o pagamento do comprador continuam a aplicar-se. Se o criador lhe atribuiu um cupão, é uma alternativa quando os cookies são recusados. Indique claramente que recebe uma comissão sempre que partilhar.",
  product: "Produto",
  productsLoaded: (most) => `Produtos publicados que geram comissão, já carregados nesta página, até ${most}. Não é o catálogo completo.`,
  shareTitle: (title) => `${title}. Ligação de afiliado: recebo uma comissão se comprar através desta ligação.`,
  resultsHead: "As suas publicações e ligações de campanha",
  resultsWaiting: "Os ganhos por campanha aguardam até a leitura das faturas e dos reembolsos estar completa.",
  resultsIntro:
    "Etiquetas de campanha registadas no pagamento ou na subscrição, não um percurso reconstruído. As compras mais antigas ou sem etiqueta continuam sem etiqueta. Os registos são compras e renovações, não compradores únicos nem cliques. A comissão é contada depois dos reembolsos registados e antes do pagamento.",
  resultsRegion: "Comissão por campanha e publicação",
  channel: "Canal",
  campaign: "Campanha",
  postVariant: "Publicação / variante",
  paidRecords: "Registos pagos",
  commission: "Comissão",
  unlabeled: "Sem etiqueta",
  showing: (shown, all) =>
    `A mostrar ${shown} de ${all} grupos de campanha. As moedas ficam separadas. Os bónus, as participações de parceiros e os ganhos de segundo nível continuam na lista de ganhos abaixo.`,
};

export const AFFILIATE_TOOL_WORDS: Record<LanguageCode, AffiliateToolWords> = { en, es, fr, de, it, nl, pt };

export function affiliateToolWords(language: unknown): AffiliateToolWords {
  return AFFILIATE_TOOL_WORDS[parseLanguage(language)];
}
