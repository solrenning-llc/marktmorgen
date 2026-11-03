/**
 * Help for buyers on marktmorgen.com (630 [HN6](34)): someone who bought
 * from a creator here and needs to get back to it, find a receipt, cancel a
 * membership, ask for a refund or reach the creator. Every answer names a
 * page that exists today (tests/buyer-help.test.ts holds each one to its
 * route) and says what Marktmorgen cannot do: the payment went to the
 * creator's own Stripe account, so the creator answers for it.
 *
 * Plain US English, short sentences (AX274, 3.1.5). Pure and import-free.
 */
export type BuyerHelpItem = { id: string; q: string; a: string[]; /** Pages it sends to, as routes in app/. */ routes: string[] };

export const BUYER_HELP_CHECKED = "November 3, 2026";

export const BUYER_HELP: BuyerHelpItem[] = [
  {
    id: "find",
    q: "Where do I find what I bought?",
    a: [
      "Open marktmorgen.com/library and type the email address you paid with. We email you a link. It opens every store you bought from, each with its own list. You do not need an account or a password.",
      "If you know the store, its own page works too: add /orders to the store's address, for example marktmorgen.com/@store-name/orders.",
    ],
    routes: ["app/library/page.tsx", "app/[handle]/orders/page.tsx"],
  },
  {
    id: "receipt",
    q: "Where is my receipt?",
    a: [
      "Your receipt is the order confirmation the store emailed you when you paid. Search your email for the store's name.",
      "If you cannot find it, reply to any email from the store and ask them to send your purchase email again. They can do that from their studio. It goes to the address you paid with.",
    ],
    routes: [],
  },
  {
    id: "cancel",
    q: "How do I cancel a membership?",
    a: [
      "Add /manage to the store's address, for example marktmorgen.com/@store-name/manage. Type the email address you pay with and open the link we email you.",
      "One button there opens your own page on Stripe, the company that takes the store's payments. Canceling there takes one click. Some stores first ask why you are leaving. Answering is up to you; the way out is on the page from the start.",
    ],
    routes: ["app/[handle]/manage/page.tsx", "app/[handle]/manage/leave/page.tsx"],
  },
  {
    id: "refund",
    q: "How do I ask for a refund?",
    a: [
      "Each store decides its own refunds. Reply to the order confirmation you were emailed when you paid. Your reply reaches the store.",
      "Marktmorgen does not hold your payment. It went straight to the creator's own account, so a refund comes from them.",
    ],
    routes: [],
  },
  {
    id: "contact",
    q: "How do I reach the creator?",
    a: [
      "Reply to any email the store sent you. Your reply reaches them.",
      "Many stores also have a contact form near the bottom of their store page, at marktmorgen.com/@store-name. Not every store turns one on.",
    ],
    routes: ["app/[handle]/page.tsx"],
  },
  {
    id: "charge",
    q: "I see a charge I do not recognize",
    a: [
      "The line on your card statement shows the name of the store you paid, not Marktmorgen, because you paid the creator directly.",
      "Open marktmorgen.com/library with each email address you use and look for that store. If none of them shows it, your bank can tell you more about the payment.",
    ],
    routes: ["app/library/page.tsx"],
  },
  {
    id: "us",
    q: "Can Marktmorgen help me?",
    a: [
      "We make the software the stores run on. We cannot see your card, change an order or send a refund, because the store holds all of that in its own accounts.",
      "If a page on marktmorgen.com does not work, write to support@marktmorgen.com. A person reads it.",
    ],
    routes: [],
  },
];
