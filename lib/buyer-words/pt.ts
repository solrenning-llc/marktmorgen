/**
 * The store's words in European Portuguese (lib/buyer-words/en.ts says what
 * each is for): the courteous third person ("o seu", "introduza"), as shops
 * in Portugal address their buyers.
 */
import type { BuyerWords } from "./index";

type Interval = "day" | "week" | "month" | "year";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const S = " ";

const every = (interval: Interval) => ({ day: "por dia", week: "por semana", month: "por mês", year: "por ano" })[interval];
/** How long an introductory price lasts (lib/intro-price.ts). */
const introFirst = (count: number, interval: Interval) => (count > 1 ? `${every("month")} nos primeiros ${count} meses` : ({ day: "no primeiro dia", week: "na primeira semana", month: "no primeiro mês", year: "no primeiro ano" })[interval]);

export const pt: BuyerWords = {
  free: "Grátis",
  fromPrice: (price) => `desde ${price}`,
  was: "Antes ",
  now: "agora ",
  every,
  membershipPrice: (trialDays, payments, interval, price) => {
    const trial = trialDays > 0 ? `${trialDays} ${plural(trialDays, "dia", "dias")} de teste grátis, depois ` : "";
    if (payments > 0) {
      const adjective = { day: plural(payments, "diário", "diários"), week: plural(payments, "semanal", "semanais"), month: plural(payments, "mensal", "mensais"), year: plural(payments, "anual", "anuais") }[interval];
      return `${trial}${payments} ${plural(payments, "pagamento", "pagamentos")} ${adjective} de ${price}`;
    }
    return `${trial}${price} ${every(interval)}`;
  },
  introFirst,
  introThen: (intro, count, interval, then) => `${intro} ${introFirst(count, interval)}, depois ${then}`,
  planWords: (payments, interval, amount) =>
    `${payments} ${plural(payments, "prestação", "prestações")} ${interval === "week" ? plural(payments, "semanal", "semanais") : plural(payments, "mensal", "mensais")} de ${amount}`,
  planCount: (payments, interval) =>
    `${payments} ${plural(payments, "prestação", "prestações")} ${interval === "week" ? plural(payments, "semanal", "semanais") : plural(payments, "mensal", "mensais")}`,
  endsIn: (unit, n) =>
    unit === "day" ? `Termina dentro de ${n} dias` : unit === "hour" ? `Termina dentro de ${n} ${plural(n, "hora", "horas")}` : `Termina dentro de ${n} ${plural(n, "minuto", "minutos")}`,

  fairHead: (country, percent) => `Preço justo para o seu país (${country}): ${percent}${S}% de desconto`,
  fairNote: (store, plan) =>
    `${store} baixa os preços onde o dinheiro vale menos. Este preço foi definido automaticamente para si, a partir do país da sua ligação à internet. O desconto é aplicado na página de pagamento, sem código${plan ? "; o preço reduzido é para pagamento integral" : ""}.`,
  saleHead: (name, percent, ends) => `${name ? `${name}: ` : ""}${percent}${S}% de desconto · ${ends}`,
  saleNote: (until, plan) =>
    `Até ${until}. O desconto é aplicado na página de pagamento, sem código${plan ? "; o preço promocional é para pagamento integral" : ""}.`,
  saleBanner: (name, percent, ends) =>
    `${name ? `${name}: ` : ""}${percent}${S}% de desconto nos produtos com o preço antigo riscado · ${ends}`,
  saleBannerNote: "Os preços abaixo já o incluem; não é preciso código.",

  callLiveNone: "Sessão em direto, online, sem datas marcadas",
  callLive: (dates) => `Sessão em direto, online, ${dates} ${plural(dates, "data marcada", "datas marcadas")}`,
  callGroup: (minutes, seats) => `Chamada de grupo, ${minutes} minutos, até ${seats} pessoas, online`,
  callOne: (minutes) => `Chamada de ${minutes} minutos, online`,
  callLengths: (list) => `Chamada de ${list} minutos, online`,
  inPersonLive: (dates) => `Sessão presencial, ${dates} ${plural(dates, "data marcada", "datas marcadas")}`,
  inPersonGroup: (minutes, seats) => `${minutes} minutos, até ${seats} pessoas, presencial`,
  inPersonOne: (minutes) => `${minutes} minutos, presencial`,
  inPersonLengths: (list) => `${list} minutos, presencial`,
  inPersonLiveNone: "Sessão presencial, sem datas marcadas",
  bundleOf: (count, worth) => `Pacote de ${count} produtos${worth ? ` · ${worth}` : ""}`,
  worth: (worth, price) => `${worth} em produtos por ${price}`,
  podcast: (episodes) => `Podcast privado, ${episodes} ${plural(episodes, "episódio", "episódios")}, na sua própria aplicação de podcasts`,
  fromCapital: "Desde ",
  pwywFact: (least, suggested) => `Pague o que quiser, desde ${least}. Sugerido: ${suggested}`,
  includes: (titles, more) => `Inclui ${titles}${more > 0 ? ` e mais ${more}` : ""}`,
  course: (lessons) => `Curso · ${lessons} ${plural(lessons, "aula", "aulas")}`,
  seeInside: "Veja o que inclui",
  readMore: "Ler mais",
  soldOut: "Esgotado",
  left: (count, written) => `${count === 1 ? "Resta" : "Restam"} ${written}`,
  bought: (count) => `Comprado ${count} vezes`,
  orPlan: (plan) => `ou ${plan}`,

  buySessions: (sessions, price) => `Comprar ${sessions} sessões — ${price}`,
  packageNote: (saving, sessions, limit) =>
    `${saving ? `${saving} a menos do que ${sessions} sessões marcadas uma a uma. ` : ""}Paga uma vez e marca cada uma quando quiser. ${limit}.`,
  packageLimit: (days) => (days ? `Utilize-as no prazo de ${days} dias` : "Sem prazo para as utilizar"),

  whichOne: "Qual",
  perPerson: " por pessoa",
  giftSummary: "Oferecer como presente",
  theirEmail: "O email da pessoa",
  yourNameShown: "O seu nome, tal como a pessoa o verá",
  messageOptional: "Uma mensagem (opcional)",
  buyAsGift: "Comprar como presente",
  buyAsGiftFor: (price) => `Comprar como presente — ${price}`,
  giftNote: (store) =>
    `Paga na página da Stripe. Depois do pagamento, o presente fica associado ao endereço da pessoa. Se o único email de ${store} lhe chegar, contém o seu nome, a sua mensagem e uma ligação para o abrir. Fica com o recibo, não com uma cópia.`,
  giftProblems: {
    email: "Isso não parece um endereço de email. Verifique o endereço do destinatário e tente novamente.",
    option: "Escolha o que quer oferecer e tente novamente. Nada foi cobrado.",
    product: "Isto já não pode ser comprado como presente.",
    unavailable: "Os presentes não estão disponíveis neste momento. Nada foi cobrado.",
  },
  teamSummary: "Comprar para uma equipa",
  howManyPeople: "Quantas pessoas",
  buyForTeam: "Comprar para a sua equipa",
  buyForTeamEach: (each) => `Comprar para a sua equipa — ${each} por pessoa`,
  teamNote:
    "Paga uma única vez na página da Stripe, onde vê o total antes de pagar. Logo a seguir, recebe uma ligação para partilhar: cada pessoa abre-a, introduz o próprio email e fica com acesso no próprio endereço. O seu lugar é ocupado da mesma forma.",
  teamProblems: (least, most) => ({
    people: `Indique quantas pessoas, de ${least} a ${most}. Nada foi cobrado.`,
    option: "Escolha o que quer comprar para todos e tente novamente. Nada foi cobrado.",
    amount: "Tantas pessoas a este preço ultrapassam o que um só pagamento pode cobrir. Tente com menos pessoas ou compre em duas vezes. Nada foi cobrado.",
    product: "Isto já não pode ser comprado para várias pessoas.",
    unavailable: "A compra para várias pessoas não está disponível neste momento. Nada foi cobrado.",
  }),

  leaveEmpty: "Deixe este campo vazio",
  comingSoon: "Em breve",
  yourEmail: "O seu email",
  emailPlaceholder: "voce@exemplo.pt",
  friendPlaceholder: "amigo@exemplo.pt",
  namePlaceholder: "Dana",
  alsoOtherEmails: (store) => `Enviem-me também outros emails de ${store}. Posso cancelar a subscrição quando quiser.`,
  alsoEmails: (store) => `Enviem-me também emails de ${store}. Posso cancelar a subscrição quando quiser.`,
  alsoClicks: (store) => `Permito que ${store} veja que ligações dos emails utilizo, para me enviar o que me interessa. Posso parar a partir de qualquer email.`,
  tellMe: "Avisem-me quando sair",
  waitlistNote: (store) =>
    `Confirma a partir da sua caixa de entrada e recebe um único email quando ficar à venda, e mais nada. O seu endereço só chega a ${store} se tiver assinalado a caixa.`,
  emailItToMe: "Enviar-me por email",
  freeNote: (store) =>
    `Recebe uma ligação por email. Quando a utilizar, ${store} recebe o seu endereço, com a indicação de que assinalou ou não a caixa. A Marktmorgen não o utiliza para mais nada.`,
  notAvailable: "Indisponível neste momento.",
  noDates: "Não há datas à venda neste momento.",
  notOnSale: "Ainda não está à venda.",
  soldOutStop: "Esgotado.",
  cannotTakePayments: "Esta loja ainda não pode receber pagamentos.",
  joinWaitlist: "Entrar na lista de espera",
  getItFree: "Obter grátis",

  pickSession: "Escolher uma sessão",
  pickTime: "Escolher um horário",
  priced: (label, price) => `${label} — ${price}`,
  /** The store's blog (lib/store-blog.ts; app/[handle]/blog). */
  blog: "Blog",
  blogOf: (store) => `Blog de ${store}`,
  blogPastEnd: "Não há publicações nesta página",
  blogPastEndBody: "Esta página fica depois da última publicação.",
  blogMinutes: (n) => `${n} min de leitura`,
  blogNewer: "Publicações mais recentes",
  blogOlder: "Publicações anteriores",
  blogAll: "Todas as publicações",
  blogPublished: (date) => `Publicado a ${date}`,
  blogFrom: (store) => `De ${store}`,
  blogFeed: "Seguir por RSS",
  /** What one unit costs within an option, when its name gives how many (lib/option-units.ts): "$7.80 per week". */
  perUnit: (price, unit) => `${price} por ${unit}`,
  /** How much less each unit costs than in the option of one. */
  unitSaving: (percent) => `poupa ${percent}%`,
  chooseOptionFor: (title) => `Escolha uma opção para ${title}`,
  chooseOne: "Escolha uma",
  recommended: "Recomendado",
  recommendedAfter: " (recomendado)",
  howToPayFor: (title) => `Como pagar ${title}`,
  payInFull: "Pagar a pronto",
  today: (amount) => `${amount} hoje`,
  addFor: (title, price) => `Adicionar ${title} por ${price}`,
  bundleBox: (count) => `Um pacote de ${count} produtos, todos seus para abrir logo depois de pagar.`,
  onItsOwn: (price) => `${price} em separado`,
  chooseYourPrice: "Escolher o seu preço",
  startTrial: (days) => `Começar o teste grátis de ${days} ${plural(days, "dia", "dias")}`,
  subscribe: "Subscrever",
  continueOption: "Continuar com esta opção",
  subscribeFor: (price, every) => `Subscrever — ${price} ${every}`,
  buyFor: (price) => `Comprar por ${price}`,
  startPlanToday: (amount) => `Começar o pagamento em prestações: ${amount} hoje`,
  startPlanWith: (named, amount) => `Começar o pagamento em prestações com ${named}: ${amount} hoje`,
  nAdded: (count) => `mais ${count} produtos`,
  buyItWith: (named) => `Comprar juntamente com ${named}`,
  buyAllFor: (boxes, price) => `${["Comprar", "Comprar os dois", "Comprar os três", "Comprar os quatro"][boxes]} por ${price}`,
  pwywNote: (least, suggested) => `Introduz o valor na página de pagamento: ${least} ou mais, ${suggested} sugerido.`,
  trialNote: (days, after, untilCancel) =>
    `Introduz o seu cartão agora e nada é cobrado durante ${days} ${plural(days, "dia", "dias")}. Depois, ${after}${untilCancel ? " até cancelar" : ""}. Se cancelar antes do fim do teste, não paga nada.`,
  switchPlansNote: "Mais tarde pode mudar para outro plano desta loja, superior ou inferior, e ver o valor exato antes de qualquer cobrança.",
  payPal: (alone, price) => `${alone ? "Comprar" : "Ou pagar"} com PayPal — ${price}`,
  payPalNote: (store) => `Pago na própria conta PayPal de ${store}. O que comprar é enviado para o endereço de email da sua conta PayPal.`,
  chooseAndBuy: "Escolher e comprar",
  memberManage: "Já é membro? Gerir ou cancelar",
  memberSwitch: "Já é membro? Mudar de plano, gerir ou cancelar",

  takenBy: (stripe, paypal) => (stripe && paypal ? "Stripe ou PayPal" : paypal ? "PayPal" : "Stripe"),
  testModeTitle: "Este pagamento está a funcionar no modo de teste da Stripe.",
  testModeBody: "Não circula dinheiro real e nenhum cartão real é cobrado, por isso não introduza um cartão seu.",
  testModeLater: (store) =>
    `Quando estiver ativo, o pagamento será cobrado pela Stripe na própria conta de ${store}: a Marktmorgen nunca detém o dinheiro nem fica com nada.`,
  paidBy: (takers, store) =>
    `O pagamento é cobrado por ${takers} na própria conta de ${store}. A Marktmorgen nunca detém o dinheiro nem fica com nada.`,
  whoAnswers: (store) =>
    `${store} é o vendedor e responde pelo que compra, pelos reembolsos e por qualquer direito de livre resolução que tenha. A Marktmorgen aloja as páginas da loja e não é parte na venda.`,
  noPaymentsTitle: "Esta loja ainda não pode receber pagamentos.",
  noPaymentsBody: (store) => `Os preços acima são reais, mas nada aqui pode cobrar um cartão. Para comprar, escreva diretamente a ${store}.`,
  noPaymentsBodyOne: (store) => `O preço acima é real, mas nada aqui pode cobrar um cartão. Para comprar, escreva diretamente a ${store}.`,

  notices: {
    soldout: { title: "Acabou de esgotar", body: "O último foi vendido momentos antes de carregar em comprar. Nada foi cobrado." },
    busy: { title: "Outra pessoa está a comprá-lo neste momento", body: "Nada foi cobrado. Carregue novamente em comprar daqui a pouco." },
    slow: { title: "Demasiadas tentativas em poucos minutos", body: "Nada foi cobrado. Aguarde alguns minutos e carregue novamente em comprar." },
    error: { title: "Não foi possível abrir a página de pagamento", body: "Nada foi cobrado. Tente novamente daqui a pouco." },
    paused: { title: "Esta loja não está a aceitar novas encomendas neste momento", body: "Nada foi cobrado. As novas encomendas reabrem no início do próximo mês, ou antes." },
    "paypal-declined": {
      title: "O PayPal não aceitou o pagamento",
      body: "Nada foi cobrado. Tente novamente com outro cartão ou outra conta no PayPal, ou pague aqui com cartão.",
    },
    "paypal-error": {
      title: "Não foi possível associar esse pagamento PayPal a esta loja",
      body: "Nada foi entregue por ele. Se o PayPal mostrar um débito, escreva à loja respondendo ao recibo do PayPal.",
    },
  },
  storeDescription: (store) => `A loja de ${store} na Marktmorgen.`,
  nothingYet: "Ainda não há nada aqui",
  nothingYetBody: (store) => `Esta página está aberta mas vazia. Quando ${store} adicionar algo, aparecerá aqui.`,
  continued: " (continuação)",
  pagesOfProducts: "Páginas de produtos",
  previous: "Anterior",
  next: "Seguinte",
  pageOf: (page, pages) => `Página ${page} de ${pages}`,
  products: (count, written) => `${written} ${plural(count, "produto", "produtos")}`,
  communityTitle: "Comunidade de membros",
  communityBody: "Para quem tem um dos produtos que dão acesso. Entre com o endereço de email que utilizou para o obter.",
  getAgain: "Comprou aqui? Volte a obter a sua compra",
  affiliateProgram: (store) => `Ganhe ao partilhar ${store}: o programa de afiliados`,
  madeWith: "Feito com Marktmorgen",

  productDescription: (title, store) => `${title}, da loja de ${store}.`,
  insideTitle: (count) => `O que inclui: ${count} produtos`,
  insideCourse: (lessons) => `Curso, ${lessons} ${plural(lessons, "aula", "aulas")} · `,
  insideNote: "Cada um é seu logo depois de pagar, como se o tivesse comprado em separado.",
  payInFullOr: (plan) => `Pague a pronto ou em ${plan}`,
  youChoose: (least) => `O preço é escolhido por si: ${least} ou mais.`,
  readFirst: (pages) => `Leia grátis ${pages === 1 ? "a primeira página" : `as primeiras ${pages} páginas`} (PDF)`,
  everythingFrom: (store) => `Tudo de ${store}`,
  getTitle: (title) => `Obter ${title}`,
  moreFrom: (store) => `Mais de ${store}`,
  pairedWith: (title) => `Combina bem com ${title}`,
  pickedBy: (store) => `Escolhido por ${store}`,
  collections: "Coleções",
  inCollections: "Faz parte de",
  productCount: (n) => `${n} ${n === 1 ? "produto" : "produtos"}`,
  alsoBought: (title) => `Quem comprou ${title} também comprou`,
  boughtBoth: (n) => `${n} compradores compraram ambos`,
  billMonthly: "Mensal",
  billYearly: "Anual",
  yearSave: (amount) => `Poupa ${amount}`,
  yearlyFact: (price, save) => `Ou ${price} ${every("year")}, com uma poupança de ${save}`,

  reviews: "Avaliações",
  verifiedReviews: (count, written) => `${written} ${plural(count, "avaliação verificada", "avaliações verificadas")}`,
  ratedFrom: (average, reviews) => `Classificado com ${average} em 5, com base em ${reviews}`,
  ratedOutOf5: (average) => `Classificado com ${average} em 5`,
  starsOutOf5: (stars) => `${stars} de 5 estrelas`,
  verifiedBuyer: "Comprador verificado",
  verifiedPurchase: "Compra verificada",
  pickedByCreator: "Escolhida pelo criador",
  refundedNotCounted: "Reembolsado, não conta",
  edited: (date) => ` · editada a ${date}`,
  replyFrom: (store) => `Resposta de ${store}`,
  starsSpread: "Como se distribuem as estrelas",
  starLabel: (stars) => `${stars} ${plural(stars, "estrela", "estrelas")}`,
  reviewCount: (count) => `${count} ${plural(count, "avaliação", "avaliações")}`,
  reviewRules: (title, store) =>
    `Só quem comprou ${title} aqui o pode avaliar, e cada avaliação é verificada com a respetiva encomenda. ${store} pode responder e ocultar uma avaliação, mas não a pode alterar; as avaliações ocultas continuam a contar na média.`,
  hiddenByCreator: (count) => `${count} ${plural(count, "avaliação ocultada", "avaliações ocultadas")} pelo criador`,
  reviewsUnreadKept: (count) => `${count} ${plural(count, "avaliação não pôde ser lida", "avaliações não puderam ser lidas")}`,
  refundedOrders: (count) => `${count} de ${plural(count, "uma encomenda reembolsada, não conta", "encomendas reembolsadas, não contam")}`,
  noReviewsYet: "As avaliações dos compradores aparecem aqui quando alguém que pagou escrever uma.",
  seeAllReviews: (written) => `Ver as ${written} avaliações`,

  askAria: "Fazer uma pergunta sobre este produto",
  askLabel: "Uma pergunta antes de comprar?",
  askPlaceholder: "É um PDF? Durante quanto tempo tenho acesso?",
  askBusy: "A ler…",
  ask: "Perguntar",
  askClosed: (store) => `As perguntas estão fechadas neste momento. Pergunte a ${store} antes de comprar.`,
  askTypeFirst: "Escreva primeiro a sua pergunta.",
  askSlow: "Demasiadas perguntas neste momento. Tente novamente dentro de alguns minutos.",
  askFailed: "Não foi possível responder agora. Tente novamente daqui a pouco.",
  askNote: (store) =>
    `Respondido automaticamente, apenas com base no que esta página diz. A sua pergunta pode ser mostrada a ${store}, sem nada sobre quem é, por isso não inclua dados pessoais.`,

  close: "Fechar",
  beforeYouGo: "Antes de sair — grátis",

  aboutStore: (store) => `Sobre ${store}`,
  guarantee: "Garantia",
  fullSize: (alt) => `${alt}, em tamanho real`,
  openFullSize: "Abrir esta imagem em tamanho real",
  countdownUnits: { days: "dias", hours: "horas", min: "min", sec: "seg" },
  until: (when) => `Até ${when}`,

  restingTitle: "Esta página está em pausa por agora",
  restingBody: (store) =>
    `Volta a abrir no início do próximo mês, ou antes. Tudo o que já tem de ${store} continua a ser seu e continua disponível.`,
  restingBuyerBody: (store) =>
    `O seu acesso mantém-se: não perde nada do que tem de ${store}. Esta página volta a abrir no início do próximo mês, ou antes.`,
  restingOwner: "Esta loja é sua? O seu estúdio explica porquê e como voltar a abri-la",

  reviewsOf: (title) => `Avaliações de ${title}`,
  backTo: (title) => `Voltar a ${title}`,
  missingTitle: "Esta página não está aqui",
  missingBody: (store) => `Pode ter sido movida ou retirada. Tudo o que ${store} oferece está na página inicial da loja.`,
  noReviewsToShow: "Não há avaliações para mostrar.",
  reviewsUnread: "Não foi possível carregar as avaliações agora. Tente de novo em instantes.",
  pagesOfReviews: "Páginas de avaliações",
  newer: "Mais recentes",
  older: "Mais antigas",
  askUnknown: (store) => `Esta página não o indica. Pergunte a ${store} antes de comprar.`,
  askTermsCut: () => "Não tenho aqui as condições completas. Pergunte ao criador antes de comprar.",

  noLongerOnSale: "Este produto já não está à venda.",
  cardUnread: "Não foi possível carregar este produto agora. Tente novamente daqui a pouco.",
  cardBuyUnread: "Não é possível comprar agora. Tente novamente daqui a pouco.",
  seeStore: (store) => `Ver ${store}`,
  cardTestMode: "Modo de teste: nenhum cartão real é cobrado.",
  cardCheckout: "Pagamento seguro pela Stripe, num novo separador.",
  cardSoldBy: (store) => `Vendido por ${store}, que responde pelo que compra.`,
  cardOpens: (store) => `Abre na loja de ${store}, num novo separador.`,

  // ---- Email cards (lib/mail-product-price.ts)
  orMore: (price) => `${price} ou mais`,
  plusTax: "+ impostos, quando aplicáveis",
  salePriceUntil: (price, when) => `Preço promocional: ${price}, até ${when}`,
};
