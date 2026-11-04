import {EVERGREEN_GUIDES,DIGITAL_FILE_GUIDE_EXTRA,DIGITAL_FILE_GUIDE_FAQ} from "@/lib/evergreen-guides";
/**
 * The whole blog lives here: categories, posts and the blocks each post is
 * built from. Nothing is fetched at run time, so a post page is a static file.
 *
 * House rule for everything written here: no invented customer, no invented
 * number, no claim about another company that we have not read on their own
 * site. Where a post states a fact about someone else, it names where it came
 * from so a reader can check it.
 */
import { PLAN_AT, feeWords, gumroadSums } from "@/lib/fee-words";
import { AFFILIATES_PAID, PAYPAL_WAITS, STAN_AFFILIATES_AHEAD, paypalAtCheckout, paypalConnectionWords } from "@/lib/public-explanations";

/** Whether a buyer can pay with PayPal here, read from the deployment so the posts say what is true on the day (lib/public-explanations.ts). */
const PAYPAL = paypalAtCheckout();

export type BlogBlock =
  | { type: "p"; text: string }
  | { type: "h2"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "steps"; items: { title: string; text: string }[] }
  | { type: "note"; text: string }
  | { type: "links"; items: { label: string; href: string }[] };

export type BlogPost = {
  slug: string;
  title: string;
  category: string;
  date: string;
  readMinutes: number;
  excerpt: string;
  kicker: string;
  from: string;
  to: string;
  body: BlogBlock[];
  faq?: {q:string;a:string}[];
};

export const BLOG_CATEGORIES = [
  "Getting started",
  "Selling digital files",
  "Money and payouts",
  "Marketing and audience",
  "Comparisons",
  "Behind the build",
  "Courses",
  "Community",
] as const;

const BASE_BLOG_POSTS: BlogPost[] = [
...EVERGREEN_GUIDES,
{
  "slug": "how-much-kajabi-costs-in-2026",
  "title": "How much Kajabi costs in 2026",
  "category": "Comparisons",
  "date": "2026-10-20",
  "readMinutes": 4,
  "excerpt": "Separate the plan, billing interval and applicable payment fees before comparing your quote.",
  "kicker": "A dated buying checklist",
  "from": "#6c3bff",
  "to": "#2546a6",
  "body": [
    {
      "type": "p",
      "text": "A useful quote starts with your own workload: products, contacts, community, payment country and billing interval. Comparing a headline with a complete invoice answers the wrong question."
    },
    {
      "type": "h2",
      "text": "Start with the published plan"
    },
    {
      "type": "p",
      "text": "On October 20, Kajabi listed Basic at $179 monthly, Growth at $249 and Pro at $499. Annual billing displayed monthly equivalents of $143, $199 and $399. Those equivalents describe an annual commitment, not monthly purchase prices."
    },
    {
      "type": "h2",
      "text": "Read the payment conditions"
    },
    {
      "type": "p",
      "text": "Its US Kajabi Payments card rates were 2.9% + $0.30, 2.8% + $0.30 and 2.7% + $0.30 respectively. When Kajabi Payments is available but another provider is selected, the page lists additional rates of 2%, 1% and 0.5%; PayPal is excluded. Country and provider conditions matter."
    },
    {
      "type": "h2",
      "text": "Compare an actual workload"
    },
    {
      "type": "steps",
      "items": [
        {
          "title": "Write down what you will use",
          "text": "List the products, contacts, payment methods and staff access you need before choosing a plan."
        },
        {
          "title": "Keep the invoice and fees separate",
          "text": "Ask which charges repeat, which depend on transactions and which are optional. A missing quote stays unknown."
        },
        {
          "title": "Inspect the alternative",
          "text": "Use the feature comparison and demo below. Marktmorgen has published limits and currently keeps paid sales closed; a demo is not a promise of availability or equivalent scope."
        }
      ]
    },
    {
      "type": "note",
      "text": "Sources read October 20, 2026. These are dated published USD figures, not a personalized checkout quote, earnings forecast or assertion that one product replaces everything in another."
    },
    {
      "type": "links",
      "items": [
        {
          "label": "Kajabi official pricing and payment conditions",
          "href": "https://www.kajabi.com/pricing"
        },
        {
          "label": "Kajabi and Marktmorgen: feature and scope comparison",
          "href": "/proof/kajabi"
        },
        {
          "label": "Marktmorgen plans, limits and local cost calculator",
          "href": "/pricing"
        },
        {
          "label": "See the live demo",
          "href": "/demo"
        }
      ]
    }
  ]
},
{
  "slug": "skool-fees-explained",
  "title": "Skool fees explained: plan, transactions and Growth Boost",
  "category": "Community",
  "date": "2026-10-20",
  "readMinutes": 4,
  "excerpt": "The monthly plan is only one line. Check transaction bands and whether discovery adds a separate commission.",
  "kicker": "Read the conditions beside the rate",
  "from": "#f5a623",
  "to": "#a94910",
  "body": [
    {
      "type": "p",
      "text": "Skool's pricing page listed Hobby at $9 a month and Pro at $99 when read on October 20, 2026. It advertises two months free for yearly billing; this article does not turn that headline into a verified annual invoice."
    },
    {
      "type": "h2",
      "text": "The payment FAQ adds detail"
    },
    {
      "type": "p",
      "text": "The FAQ lists Hobby at 10% + $0.30 per transaction. Pro is 2.9% + $0.30 up to $899 and 3.9% + $0.30 above $900. Its wording leaves the exact $900 boundary unclear: confirm it rather than invent a rate. Transaction fees are non-refundable."
    },
    {
      "type": "h2",
      "text": "Discovery can be another line"
    },
    {
      "type": "p",
      "text": "Growth Boost charges a 30% commission plus the selected plan's fees when Skool brings a paying member. The FAQ says it is on by default, can be switched off, and its cut follows recurring charges while that membership remains active. It uses Stripe Express for payouts, rather than your existing Stripe account."
    },
    {
      "type": "h2",
      "text": "Use your mix of transactions"
    },
    {
      "type": "ul",
      "items": [
        "Keep payment amounts and counts separate; one average can hide a pricing band.",
        "Check whether a member arrived through Growth Boost before applying its commission.",
        "Compare payout arrangements and the community experience as well as subscription costs. Lower fixed cost alone does not establish a better fit."
      ]
    },
    {
      "type": "note",
      "text": "Official sources read October 20, 2026. No exact annual invoice or unresolved transaction band is treated as zero. Marktmorgen paid sales remain closed; its community and pricing pages describe actual scope and limits, not a Skool Discovery substitute."
    },
    {
      "type": "links",
      "items": [
        {
          "label": "Skool official plan prices",
          "href": "https://www.skool.com/pricing"
        },
        {
          "label": "Skool official payment and Growth Boost FAQ",
          "href": "https://help.skool.com/article/86-subscriptions-faq"
        },
        {
          "label": "Skool and Marktmorgen comparison",
          "href": "/proof/skool"
        },
        {
          "label": "Marktmorgen community scope",
          "href": "/platform/community"
        },
        {
          "label": "Plans and local cost calculator",
          "href": "/pricing"
        }
      ]
    }
  ]
},
{
  "slug": "kajabi-vs-teachable-vs-marktmorgen",
  "title": "Kajabi vs Teachable vs Marktmorgen: what to check",
  "category": "Courses",
  "date": "2026-10-20",
  "readMinutes": 4,
  "excerpt": "Compare the teaching experience, payment arrangement and full quote against the work you actually need to do.",
  "kicker": "Choose by the work, not a promised result",
  "from": "#145b67",
  "to": "#313080",
  "body": [
    {
      "type": "p",
      "text": "Begin with a small acceptance checklist: show a lesson, grant access, issue a refund, export permitted records and explain a renewal. A product name on a feature list does not prove that all three platforms handle those tasks in the same way."
    },
    {
      "type": "h2",
      "text": "Choose the teaching experience"
    },
    {
      "type": "p",
      "text": "Teachable's October 20 pricing listed Starter, Builder and Growth at $39, $89 and $189 monthly, with annual monthly equivalents of $29, $69 and $139. Product counts were 5, 10 and 50. Custom needs a quote; the annual display is not an independently verified invoice."
    },
    {
      "type": "h2",
      "text": "Separate the fees"
    },
    {
      "type": "p",
      "text": "Teachable distinguishes its plan fee from processing: Starter is 7.5%; Builder and Growth have no plan transaction fee. Processing depends on country, method, gateway and bundle. Its help center also identifies a 2% integration fee for US custom-gateway schools; that is separate from Stripe processing."
    },
    {
      "type": "h2",
      "text": "Check Marktmorgen's actual boundaries"
    },
    {
      "type": "p",
      "text": "Marktmorgen's course page describes its lesson and access tools. Its pricing page reads the current plan prices and allowances from the product's own configuration. Paid sales remain closed. Inspect the demo, compare the published limits and verify migration needs before treating any option as a replacement."
    },
    {
      "type": "steps",
      "items": [
        {
          "title": "Test a representative lesson",
          "text": "Check the format, navigation and access rules your buyers will encounter. An attractive cover does not establish a teaching workflow."
        },
        {
          "title": "Ask for the complete applicable quote",
          "text": "Include the invoice interval, processing, recurring charges, integrations, tax handling and optional bundles. Unanswered lines remain unknown."
        },
        {
          "title": "Keep a migration checklist",
          "text": "Confirm which contacts, purchases and content can move with permission, and which subscriptions or settings need separate handling. Do not assume a logo comparison proves portability."
        }
      ]
    },
    {
      "type": "note",
      "text": "Sources read October 20, 2026. This checklist makes no earnings, savings or blanket feature-equivalence claim. Existing buyer languages, creator content and permissions must survive any migration."
    },
    {
      "type": "links",
      "items": [
        {
          "label": "Kajabi official pricing",
          "href": "https://www.kajabi.com/pricing"
        },
        {
          "label": "Teachable official pricing",
          "href": "https://www.teachable.com/pricing"
        },
        {
          "label": "Teachable official processing, bundles and gateway fees",
          "href": "https://support.teachable.com/en/articles/15661316-understand-your-transaction-fees-and-bundles"
        },
        {
          "label": "Detailed Kajabi comparison",
          "href": "/proof/kajabi"
        },
        {
          "label": "Detailed Teachable comparison",
          "href": "/proof/teachable"
        },
        {
          "label": "Marktmorgen course capabilities",
          "href": "/platform/courses"
        },
        {
          "label": "Marktmorgen prices and limits",
          "href": "/pricing"
        },
        {
          "label": "Migration scope and limitations",
          "href": "/platform/switching-to-marktmorgen"
        }
      ]
    }
  ]
},
  {
    slug: "what-selling-on-gumroad-costs",
    title: "What selling on Gumroad actually costs, in money and in days",
    category: "Comparisons",
    date: "2026-09-20",
    readMinutes: 9,
    excerpt:
      "The fee on their pricing page is not the fee on the sale, the money lands in their balance rather than yours, and there is a good reason for both. The whole arithmetic, from their own pages.",
    kicker: "Read before you pick a platform",
    from: "#ff8a1f",
    to: "#c81e5a",
    body: [
      {
        type: "p",
        text: "Gumroad's pricing page shows two numbers: 10% plus 50 cents on a sale you bring yourself, and 30% on a sale their Discover marketplace brings you. There is no monthly fee. That is a clear offer and for plenty of people it is the right one. It is also not the whole cost, and the rest is not hidden \u2014 it is written in their own help center, on the pages most sellers open only after something has gone wrong.",
      },
      { type: "h2", text: "The fee on the pricing page does not include the card fee" },
      {
        type: "p",
        text: "Their fees article says it plainly: the 10% plus 50 cents does not cover credit card processing, which they put at 2.9% plus 30 cents. Both come out of the same sale.",
      },
      {
        type: "p",
        text: "On a $27 file sold through your own link, that is $3.20 to Gumroad and about $1.08 in card processing. You keep $22.72. Nothing here is concealed. The two figures simply live on two different pages, and only one of them is on the page you read before signing up.",
      },
      {
        type: "p",
        text: "One more figure, because it runs in your favor: once your paid sales in a calendar month reach $20,000, new direct sales for the rest of that month are charged 5% plus 50 cents instead. It resets on the first of the month, and there is nothing to apply for. At $27 a file, that threshold is around 740 sales in a month.",
      },
      { type: "h2", text: "The money arrives in their balance, not in yours" },
      {
        type: "p",
        text: "This is the part that surprises people. A card sale does not land in your bank account, and it does not land in a payment account of yours. It lands in a Gumroad balance, and it leaves that balance on a schedule. The one exception is PayPal: if you have connected your own PayPal account, a sale paid with PayPal is credited to it at the time of sale.",
      },
      {
        type: "ul",
        items: [
          "You need at least $100 in your balance before a payout is sent at all. A number of countries have a higher minimum in local currency.",
          "On the weekly, monthly and quarterly schedules, a sale waits at least seven days in the balance before it is eligible to leave.",
          "A payout covers sales made up to the previous Friday, counted in UTC.",
          "Your payout day depends on how you are paid and, for a bank account, on its country: Tuesday, Wednesday or Thursday for bank accounts, Friday for PayPal. The bank transfer itself then takes a further two to seven business days.",
          "Before your first payout, they review the account. They say that takes one to three weeks.",
          "Getting it sooner costs: PayPal payouts carry a 2% fee, and instant payouts cost 3%, are for creators in the United States only, and open only after a first payout and sixty days of processing.",
          "You are paid in your local currency, converted at the exchange rate at the time of the sale rather than the time of the payout.",
        ],
      },
      {
        type: "p",
        text: "Put those together for somebody making their first sales and the distance between a buyer paying and you having the money can run to several weeks \u2014 almost all of it structural, none of it anything you did wrong.",
      },
      { type: "h2", text: "Why it is built that way" },
      {
        type: "p",
        text: "It would be easy to make that sound like a trap. It is not. Since January 1, 2025, Gumroad has been the merchant of record, which means they are legally the seller and you are not. They say so on their own pricing page, and it is why they collect and remit sales tax worldwide.",
      },
      {
        type: "p",
        text: "Being the seller is what pays for the things Gumroad genuinely takes off your hands: VAT in the European Union, GST where it applies, state sales tax in the United States, collected and filed without you ever learning what any of it means. It is also what forces everything in the list above. If the sale is legally theirs, the money is theirs first. If their bank holds them responsible for that sale, they have to hold something back against a refund or a chargeback, and they have to be able to stop an account that is costing them.",
      },
      {
        type: "p",
        text: "Their own suspension page does not dress this up either. They explain that they have to follow the rules of their banking partners and payment processors in order to keep operating, that this sometimes means removing a creator they would rather keep, and that depending on which policy was broken they may not be able to pay a remaining balance out.",
      },
      {
        type: "note",
        text: "Read that last sentence as a seller rather than as a critic. It is honest and it is accurate, and it is the real price of the 10%. You are not renting a checkout. You are selling through somebody else's company, with their bank and their appetite for risk.",
      },
      { type: "h2", text: "What the other arrangement looks like" },
      {
        type: "p",
        text: "The alternative is not a cheaper version of the same thing. It is a different arrangement, and it costs you something too.",
      },
      {
        type: "p",
        text: "You open your own Stripe account. The buyer's card is charged on it directly. The money is in your account at the moment of the sale, your own business name is on the buyer's statement, and the payout schedule is whatever you set in your own Stripe dashboard. No platform holds a balance for you: the balance is in your own Stripe account.",
      },
      {
        type: "p",
        text: "Then the bill for that. You are the seller of record, so the sales tax is yours to work out. A chargeback is argued by you. A refund is one you issue. Nobody stands between you and your buyer, which is the whole point, and it is also the work.",
      },
      { type: "h2", text: "The arithmetic, at four sizes" },
      {
        type: "steps",
        items: [
          {
            title: "Five sales of $27 in a month",
            text: gumroadSums().five,
          },
          {
            title: gumroadSums().evenTitle,
            text: gumroadSums().even,
          },
          {
            title: "A hundred sales of $27",
            text: gumroadSums().hundred,
          },
          {
            title: "Five hundred sales of $27",
            text: gumroadSums().fiveHundred,
          },
        ],
      },
      {
        type: "p",
        text: gumroadSums().gap,
      },
      { type: "h2", text: "Which one you should actually be on" },
      {
        type: "p",
        text: gumroadSums().stay,
      },
      {
        type: "p",
        text: "If being the seller of record is the part that worries you \u2014 if the thought of being personally answerable for sales tax in countries you have never visited is what keeps you up \u2014 stay on Gumroad whatever the arithmetic says. That is a good reason, and the math does not beat it.",
      },
      {
        type: "p",
        text: gumroadSums().move,
      },
      {
        type: "note",
        text: "Every figure here is from Gumroad's own pages, read on September 20, 2026 and checked again on September 28, 2026: their pricing page for 10% plus 50 cents, 30% on Discover and the merchant-of-record change of January 1, 2025; “Gumroad's fees” for card processing at 2.9% plus 30 cents not being included and for the $20,000 discount; “Getting paid by Gumroad” for the $100 minimum, the seven-day hold, the payout days, the 2% PayPal fee, the 3% instant payout, the currency conversion and the one-to-three-week review; “Adding PayPal to checkout” for PayPal sales paid into your own PayPal account; and their “Account suspension FAQ” for what can happen to a balance. The same 2.9% plus 30 cents is Stripe's published United States rate for domestic cards. If any of it has changed since, this page is wrong until we fix it, and we would rather be told than left looking accurate.",
      },
    ],
  },
  {
    slug: "sell-a-digital-file-from-your-bio",
    title: "How to sell a digital file from the link in your bio",
    category: "Getting started",
    date: "2026-09-18",
    readMinutes: 6,
    excerpt:
      "The whole path, from the file on your laptop to the money in your bank: what to make, what to charge, what the page needs to say, and what has to happen the second someone pays.",
    kicker: "Start here",
    from: "#6c3bff",
    to: "#ff3d8a",
    body: [
      {
        type: "p",
        text: "Selling a file is the shortest path from an audience to an income, because there is nothing to ship, nothing to restock and no call to schedule. It is also where most people stall, because the path has five steps and the internet usually explains two of them.",
      },
      { type: "h2", text: "1. Sell the thing you already answer" },
      {
        type: "p",
        text: "The product you can finish this week is the answer you keep repeating in your replies. A meal planner, a set of presets, a checklist, a template, a workbook, a swipe file of your own messages. If three people have asked you the same question, that question is the product. You are not writing a book; you are packaging an answer.",
      },
      {
        type: "p",
        text: "Keep the first one small on purpose. A five-page PDF that solves one problem sells better than a forty-page one that covers a subject, because the buyer can see the end of it before they pay.",
      },
      { type: "h2", text: "2. Price it where the decision is easy" },
      {
        type: "p",
        text: "For a first digital file, the price that moves is usually somewhere between the price of a coffee and the price of a dinner. Below that, people wonder what is wrong with it. Above it, they start comparing you with a course.",
      },
      {
        type: "p",
        text: "Better than guessing a single number: give the same product two or three sizes. One week of meals for $27, five weeks for $39, the whole season for $79. The buyer stops deciding whether to buy and starts deciding which one — and a good share of them pick the middle.",
      },
      { type: "h2", text: "3. Write the page as an answer, not a pitch" },
      {
        type: "ul",
        items: [
          "Say what the buyer gets, in nouns: “A 12-page PDF with 5 weeks of dinners and the shopping list for each week.”",
          "Say who it is for and who it is not for. Turning the wrong buyer away is what makes the right one trust you.",
          "Say what happens after payment, in one sentence, before they pay.",
          "Show one page of the thing. A single honest screenshot beats a paragraph of adjectives.",
          "Do not invent reviews. A new product with no reviews and a clear description outsells a new product with reviews nobody believes.",
        ],
      },
      { type: "h2", text: "4. Make the checkout boring" },
      {
        type: "p",
        text: "Every extra field loses buyers. On a phone, the whole purchase should be: tap the price, type an email, pay with the card already in the phone's wallet. No account to create, no password to invent, no app to install.",
      },
      {
        type: "p",
        text: "Whatever you use to collect the money, check two things before you launch: that Apple Pay and Google Pay appear on a phone, and that the price shown on the product is the price charged at the end. A surprise fee at the last screen is the most expensive kind of surprise.",
      },
      { type: "h2", text: "5. Deliver in the same second" },
      {
        type: "p",
        text: "The moment after payment is the whole relationship. If the file appears immediately, you are a business. If it arrives in an email twenty minutes later, you are a person who might have forgotten.",
      },
      {
        type: "note",
        text: "Test your own checkout with a real card before you send a single person to it. Buy your own product. Read the confirmation. Download the file on a phone, on mobile data, not on your home Wi-Fi. Most broken stores were never bought from by their owner.",
      },
      { type: "h2", text: "What to do this week" },
      {
        type: "steps",
        items: [
          {
            title: "Monday",
            text: "Write down the question you answer most. That is the product.",
          },
          {
            title: "Tuesday and Wednesday",
            text: "Make the file. Stop when it solves the one problem. Export it as a PDF.",
          },
          {
            title: "Thursday",
            text: "Write the page: what it is, who it is for, what happens after payment. Three prices if the product has sizes.",
          },
          {
            title: "Friday",
            text: "Buy it yourself. Fix whatever annoyed you. Then put the link in your bio and tell people what you made.",
          },
        ],
      },
    ],
  },
  {
    slug: "what-it-costs-to-sell-a-27-dollar-file",
    title: "What it really costs to sell a $27 file",
    category: "Money and payouts",
    date: "2026-09-18",
    readMinutes: 5,
    excerpt:
      "Card fees, platform fees, subscriptions and payout fees, added up on one sale and on a hundred — so you can see which cost is worth paying and which one quietly eats the month.",
    kicker: "The math",
    from: "#12d6a4",
    to: "#37b6ff",
    body: [
      {
        type: "p",
        text: "Most platforms advertise one number, and a sale pays several. Here is the whole stack, in the order it comes out of a sale.",
      },
      { type: "h2", text: "The card fee" },
      {
        type: "p",
        text: "Someone has to move the money. Card networks and payment processors take a percentage plus a fixed amount per transaction — Stripe publishes its own rates, and in the United States the standard online rate for domestic cards has been 2.9% plus 30 cents for years. On a $27 sale that is about $1.08, so roughly $25.92 reaches you.",
      },
      {
        type: "p",
        text: "Nobody escapes this one. When a service says it takes nothing, it means nothing on top of this. The card fee is still paid, whether by you to your own payment processor, out of the subscription you pay the service, or before you see the number.",
      },
      { type: "h2", text: "The platform fee" },
      {
        type: "p",
        text: "This is the cut the store takes on top of the card fee. It is the one number worth reading carefully, because a percentage grows with you and a fixed price does not.",
      },
      {
        type: "ul",
        items: [
          "A 5% platform fee on a $27 file is $1.35 — more than a dollar on every sale, forever.",
          "At 100 sales a month, that is $135 a month. At 500, it is $675 a month.",
          "A fixed monthly price does the opposite: it hurts at 3 sales and disappears at 300.",
        ],
      },
      { type: "h2", text: "The subscription" },
      {
        type: "p",
        text: "Most creator stores charge a monthly fee. Compare it against your real volume, not your hoped-for volume: a $29 monthly plan on 3 sales of $27 is eating more than a third of the money; on 100 sales it is barely 1%.",
      },
      {
        type: "note",
        text: "The honest way to compare two stores is to write your own number of sales into both. A platform that is cheaper for someone selling 500 files a month can be the expensive one for you, and the reverse is just as true.",
      },
      { type: "h2", text: "The payout" },
      {
        type: "p",
        text: "Then there is getting the money out. Two questions decide how much this costs you: how long the money sits before it is released, and whether it is converted into another currency on the way. Currency conversion is where the quiet fee lives — a percentage on top of the exchange rate, charged on every payout, often invisible on the dashboard.",
      },
      {
        type: "p",
        text: "If the money lands directly in your own payment account, in your own currency, on your own schedule, that cost is zero and the timing is yours.",
      },
      { type: "h2", text: "One sale, added up" },
      {
        type: "ul",
        items: [
          "Sale price: $27.00",
          "Card fee at 2.9% + $0.30: about $1.08",
          "Platform fee at 5%: $1.35 — or $0 if the store does not take a cut",
          "Left before the monthly plan: $24.57 with a 5% cut, $25.92 without",
        ],
      },
      {
        type: "p",
        text: "The gap looks small on one sale. It is $135 a month at a hundred sales, and it is the difference between a hobby paying for itself and a hobby paying you.",
      },
    ],
  },
  {
    slug: "your-own-stripe-account",
    title: "Why the money should land in your own Stripe account",
    category: "Money and payouts",
    date: "2026-09-18",
    readMinutes: 5,
    excerpt:
      "There are two ways a creator store can handle your money, and they are not close. One gives you a balance on someone else's dashboard; the other gives you a payment account that is yours.",
    kicker: "How the money moves",
    from: "#ffb020",
    to: "#ff3d8a",
    body: [
      {
        type: "p",
        text: "When a buyer pays for your file, the money goes somewhere before it reaches you. Where exactly it goes is the single most important thing to understand about any platform you sell on, and almost nobody explains it.",
      },
      { type: "h2", text: "The first way: the platform holds it" },
      {
        type: "p",
        text: "The buyer pays the platform. The platform records that you are owed the money and shows you a balance. Later, on the platform's schedule and under the platform's rules, it sends you a payout.",
      },
      {
        type: "p",
        text: "Everything about that arrangement is a decision someone else makes: when the balance is released, what the minimum payout is, which countries can receive it, what happens if a buyer disputes a charge, and what happens to the balance if your account is closed. You are a line in someone's ledger.",
      },
      { type: "h2", text: "The second way: the money never stops at the platform" },
      {
        type: "p",
        text: "You connect your own payment account — your own Stripe account, in your own name, with your own bank details. The buyer's card is charged on your account. The money lands in your balance, on the payout schedule you set, in your currency.",
      },
      {
        type: "ul",
        items: [
          "The customer's receipt carries your business name, not the platform's.",
          "Refunds and disputes are handled by you, with the tools of a real payment account, not a support ticket.",
          "Your payout schedule is a setting you control.",
          "If you leave the platform tomorrow, your payment account, your customer records and your money stay where they are.",
        ],
      },
      {
        type: "note",
        text: "There is one honest trade-off: connecting your own account means you go through the payment processor's verification — your identity, your business details, your bank account. It takes longer on day one than typing a username. It is also the difference between having a business and having an account on a website.",
      },
      { type: "h2", text: "How to check which one you are on" },
      {
        type: "p",
        text: "You do not have to read the terms of service. Look at two screens.",
      },
      {
        type: "steps",
        items: [
          {
            title: "The receipt",
            text: "Buy something from your own store. Whose name is on the receipt and the card statement line — yours, or the platform's?",
          },
          {
            title: "The payout page",
            text: "Does it show a balance the platform will send you later, or does it link to a payment account in your own name with its own dashboard?",
          },
        ],
      },
      {
        type: "p",
        text: "If the receipt says your name and the payout page is your own account, the money is yours from the first second. If not, you are holding a promise, and promises have terms.",
      },
    ],
  },
  {
    slug: "three-prices-for-one-product",
    title: "One product, three prices: the simplest way to earn more per buyer",
    category: "Selling digital files",
    date: "2026-09-18",
    readMinutes: 4,
    excerpt:
      "Most creators sell one file at one price. Giving the same work three sizes changes the question in the buyer's head from “should I?” to “which one?,” and that question is far easier to answer.",
    kicker: "Pricing",
    from: "#6c3bff",
    to: "#12d6a4",
    body: [
      {
        type: "p",
        text: "A single price makes the buyer decide between your product and nothing. Three prices make them decide between three versions of your product. The second decision is the one you want them making.",
      },
      { type: "h2", text: "How to cut one product into three" },
      {
        type: "p",
        text: "You do not need three products. You need three honest sizes of the same work.",
      },
      {
        type: "ul",
        items: [
          "By amount: one week of meal plans, five weeks, the whole season.",
          "By format: the PDF; the PDF plus the editable file; the PDF, the editable file and the video walkthrough.",
          "By use: for yourself; for a team; for your clients (a license to use it in your own work).",
        ],
      },
      {
        type: "p",
        text: "What matters is that each tier is genuinely more of something, and that the description says exactly what the extra is. A tier that is the same product with a nicer name is the kind of thing buyers notice and remember.",
      },
      { type: "h2", text: "Where to put the price you want people to pick" },
      {
        type: "p",
        text: "Put it in the middle and make it obviously good value — a clear drop in the price per week, per template or per page from the smallest size. Say that out loud on the page. “Five weeks for $39” next to “one week for $27” does the arithmetic for the buyer.",
      },
      {
        type: "note",
        text: "One thing to never do: fake the top tier. A price nobody is meant to buy, invented to make the middle look good, is a trick. Sell three things you would be happy to deliver, and let the buyer pick freely.",
      },
      { type: "h2", text: "What changes on the page" },
      {
        type: "p",
        text: "The product page stops being a wall of copy with a button at the bottom. It becomes a short description and three rows the buyer taps. Show the “from” price at the top of the store so the cheapest tier is what catches the eye, and let the choice happen on the product, one tap before the card.",
      },
      {
        type: "p",
        text: "Then deliver the right file for the tier that was paid for. That sounds obvious and it is the part that breaks most often: the buyer pays for five weeks and receives the one-week file, because the two were never really separate products in the system. Test each tier the way a buyer would, with a real payment, before you publish.",
      },
    ],
  },
  {
    slug: "product-page-that-sells-a-file",
    title: "How to write a product page that sells a file",
    category: "Marketing and audience",
    date: "2026-09-18",
    readMinutes: 5,
    excerpt:
      "Six lines, in order, and what each one has to do. Written for people selling a PDF to buyers on their phones, not for people writing sales letters.",
    kicker: "Copy",
    from: "#37b6ff",
    to: "#6c3bff",
    body: [
      {
        type: "p",
        text: "A digital product page has one job: make someone who has never met you confident enough to type their card number. On a phone, you have about six lines of attention to do it in. Here is what each line should carry.",
      },
      { type: "h2", text: "Line 1 — the name, said plainly" },
      {
        type: "p",
        text: "“Weekly Meal Planner” beats “The Nourish Method.” A clever name asks the reader to learn something before they can want it. Save the clever name for when people already know you.",
      },
      { type: "h2", text: "Line 2 — what it physically is" },
      {
        type: "p",
        text: "A 12-page PDF. A set of 30 presets. A spreadsheet with four tabs. Buyers relax when they know the shape of the thing they are getting. Vagueness reads as risk.",
      },
      { type: "h2", text: "Line 3 — the one problem it removes" },
      {
        type: "p",
        text: "Not the transformation. The problem, in the reader's own words: “You stop deciding what to cook at 6 p.m.” If you cannot write this line, the product is not finished yet.",
      },
      { type: "h2", text: "Line 4 — who it is for, and who it is not" },
      {
        type: "p",
        text: "“For two people who cook three or four nights a week. Not for bulk meal prep.” Saying who should not buy it is the strongest trust signal a new seller has, and it cuts refunds.",
      },
      { type: "h2", text: "Line 5 — what happens after payment" },
      {
        type: "p",
        text: "“You get the download on the next screen, and a copy by email.” Say this before the price, not after. The fear of paying and being left waiting is the last thing standing between a reader and a sale.",
      },
      { type: "h2", text: "Line 6 — the price, with the options visible" },
      {
        type: "p",
        text: "Show the choices as rows the buyer can tap, with what each one includes. No math for them to do, no “contact for pricing,” no discount timer that resets when they reload the page.",
      },
      { type: "h2", text: "What to leave out" },
      {
        type: "ul",
        items: [
          "Testimonials you do not have. An empty review section is better than an invented one, and inventing them is against the law in the United States and the European Union.",
          "Countdown timers that are not real deadlines.",
          "“Normally $197, today $27.” If it was never $197, that sentence is a lie with a number in it.",
          "Long autobiography. One line about why you are the person to make this is plenty on a product page.",
        ],
      },
      {
        type: "note",
        text: "Read your finished page out loud on your phone. Anything you stumble over, a buyer skipped.",
      },
    ],
  },
  {
    slug: "link-in-bio-is-not-the-product",
    title: "The link in your bio is not the product. The offer is.",
    category: "Marketing and audience",
    date: "2026-09-18",
    readMinutes: 4,
    excerpt:
      "People change their store page fonts for a week and wonder why nothing sold. The page is a wrapper. What sells is one clear offer that the audience already asked for.",
    kicker: "Strategy",
    from: "#ff3d8a",
    to: "#ffb020",
    body: [
      {
        type: "p",
        text: "Every creator store on the market can hold a photo, a few links and a product. The differences between them matter — fees, delivery, where the money lands — but none of them will sell anything if the offer on the page is not one the audience wanted.",
      },
      { type: "h2", text: "The order almost everyone gets wrong" },
      {
        type: "p",
        text: "The common order is: pick a platform, design the page, then wonder what to sell. The order that works is the reverse.",
      },
      {
        type: "steps",
        items: [
          {
            title: "Find the repeated question",
            text: "Go through your replies, comments and messages from the last month. Write down every question that appeared more than twice.",
          },
          {
            title: "Answer one of them completely",
            text: "Make the file that ends that question for good. One question, one file.",
          },
          {
            title: "Say it in one sentence",
            text: "“Five weeks of dinners for two people, with the shopping list.” That sentence is the offer; everything else is decoration.",
          },
          {
            title: "Then build the page",
            text: "Now the page has a job, and building it takes an afternoon.",
          },
        ],
      },
      { type: "h2", text: "Why one offer beats five" },
      {
        type: "p",
        text: "A store with five products asks a visitor to choose before they trust you. A store with one product and three sizes asks them to choose how much of a thing they already want. The second store converts better and is far easier to talk about in a post.",
      },
      {
        type: "p",
        text: "Add the second product when the first one is selling without you thinking about it. Not before.",
      },
      { type: "h2", text: "Talk about the offer, not the store" },
      {
        type: "p",
        text: "Nobody follows you for your store page. Post the thing itself: a page of the planner, the before and after, the mistake the guide fixes. Then say where it is. A post about the product with the link at the end beats a post about the link every time.",
      },
    ],
  },
  {
    slug: "how-marktmorgen-compares-with-stan",
    title: "How Marktmorgen compares with Stan, written by the people building Marktmorgen",
    category: "Comparisons",
    date: "2026-09-18",
    readMinutes: 6,
    excerpt:
      "We are not a neutral source and we are not going to pretend otherwise. Here is what each one does, what Stan does better today, and the one thing we do differently on purpose.",
    kicker: "Comparison",
    from: "#140f3d",
    to: "#6c3bff",
    body: [
      {
        type: "note",
        text: "Disclosure: we build Marktmorgen. Everything below about Stan comes from Stan's own website and help center, which anyone can read. Where we are worse, we say so.",
      },
      {
        type: "note",
        text: "Updated on September 26, 2026, when Marktmorgen added a community, funnels of offers after the checkout, an affiliate program you pay out yourself, calendar sync and webhooks. The lines below say where that leaves each of us.",
      },
      {
        type: "note",
        text: "Updated again on September 27, 2026, when Marktmorgen added sales and landing pages; reviews only buyers can write; 15 currencies; the ways to pay that a creator switches on in Stripe; Mailchimp, Kit, beehiiv and MailerLite built in; up to five stores and a team with roles; a video room for each booking; phone notifications; and up to 2,000 products.",
      },
      {
        type: "note",
        text: "And later the same day, when Marktmorgen added live events inside the community, bundles of products, drafts, and importing a list, products and past buyers from another platform. Later still, it added Google Meet links made on your own Google Calendar.",
      },
      {
        type: "note",
        text: `Corrected on November 1, 2026: an earlier version gave only half the PayPal story and said affiliates are not paid automatically. Stripe does not offer its own PayPal for the direct charges every sale here is made with; that part was right. ${paypalConnectionWords(PAYPAL)} And affiliates can be paid automatically on your payday, from your own PayPal.`,
      },
      { type: "h2", text: "What Stan is" },
      {
        type: "p",
        text: "Stan is a creator store that has been running for years and sells a wide product range from one dashboard. Their own help center lists what a creator can sell there: digital downloads, e-courses, coaching calls, webinars, memberships, communities, lead magnets, external links and custom products, plus order bumps and funnels, an affiliate share program, email marketing and their AutoDM tool.",
      },
      {
        type: "p",
        text: "That is a large product. A community in the same place as your store, with live sessions inside it, is something we both have now. Theirs are webinars members sign up for, with Zoom or Google Meet links made automatically; ours are live events members RSVP to, in a private Jitsi Meet room shown in the page, at the creator's own link, or in a Google Meet made on the creator's connected Google Calendar. No Zoom link is made for you yet.",
      },
      { type: "h2", text: "What Marktmorgen is" },
      {
        type: "p",
        text: "Marktmorgen is a store page for selling files, courses, memberships, communities and calls, and it is early. At its core are three things: a colorful page, price options on a product, and the file in the buyer's hands the second the payment clears.",
      },
      { type: "h2", text: "The one thing we do differently" },
      {
        type: "p",
        text: feeWords().blogMoney,
      },
      {
        type: "p",
        text: feeWords().blogStan,
      },
      { type: "h2", text: "Where Stan is ahead of us today" },
      {
        type: "ul",
        items: [
          `Range: automatic Instagram replies, ${PAYPAL ? "" : "PayPal at checkout, "}${STAN_AFFILIATES_AHEAD}, one builder for funnels, Zoom links made for each booking and webinar, and stores with no limit on products. We have none of those. ${PAYPAL ? "" : `PayPal is not at our checkout yet: ${PAYPAL_WAITS}. `}Our affiliates are ${AFFILIATES_PAID}, which needs a PayPal Business account with Payouts switched on; our funnels are pages and offers you connect rather than one builder; our video rooms, for calls and live events alike, are Google Meet links made on your connected Google Calendar, your own meeting link, or Jitsi Meet rooms, where the first person in may have to sign in to Jitsi; and a store holds up to 2,000 products.`,
          "Years of running: their support library is deep, and ours is a few pages.",
          "A native creator app: their help center states their creator app is currently available only on iPhone and iPad. We do not have a native app at all — our studio and every store install to the home screen from the browser, on both iPhone and Android, and the studio can send notifications of sales, which is a different trade-off, not a better one in every case.",
          "Integrations with third-party tools, which they list on their site. We have webhooks that Zapier, Make or your own server can catch, and no app of our own in anyone's directory.",
        ],
      },
      { type: "h2", text: "Where we think we are ahead" },
      {
        type: "ul",
        items: [
          "The money lands in your own Stripe account, so payouts, receipts and refunds are yours.",
          "Price options on a single product, with the right file delivered for the tier that was paid for.",
          "Reviews only buyers can write, checked against the payment. Stan's help center says reviews there are added by the creator.",
          "A team with roles, each person signing in with their own email. Stan's help center says the only way to give someone admin access to a store there is to share your login.",
          `Sales pages, landing pages, discount codes, payment plans and offers after payment on the ${PLAN_AT.creator} plan (Stan's help center puts discount codes, payment plans and upsells on their $99 Creator Pro plan), and a store in any of 15 currencies.`,
          "Bundles that hand over each of your products as if bought on its own. Stan's help center lists bundles among the files you can sell as one download.",
          "Moving in from a spreadsheet: up to 50,000 contacts, 500 products and 20,000 past buyers per file, where Stan's help center sets a limit of 5,000 imported contacts per store in all, and buyers are given access one at a time.",
          "A live demo store anyone can buy from with a test card, before signing up for anything.",
          "Terms and privacy policy published as pages on the site, where Stan links to them as PDF files.",
        ],
      },
      { type: "h2", text: "How to decide without trusting either of us" },
      {
        type: "steps",
        items: [
          {
            title: "Write down your own numbers",
            text: "Your price, your sales per month and the features you actually need. Find the plan each platform would put you on for those features, and compare the monthly totals.",
          },
          {
            title: "Buy something from both",
            text: "Go through a real checkout on each. Whose name is on the receipt? How fast did the file arrive? Could you do it on a phone with one hand?",
          },
          {
            title: "Read the payout page",
            text: "A balance the platform sends you later, or a payment account in your name? That answer outlives every other feature on the list.",
          },
        ],
      },
    ],
  },
  {
    slug: "why-we-skipped-the-app-stores",
    title: "Why your store installs from the browser instead of an app store",
    category: "Behind the build",
    date: "2026-09-18",
    readMinutes: 4,
    excerpt:
      "Your buyer should never have to download anything to buy a file. Here is the reasoning behind that decision, and the honest cost of it.",
    kicker: "How we built it",
    from: "#04624a",
    to: "#12d6a4",
    body: [
      {
        type: "p",
        text: "A Marktmorgen store is a web page that can be installed to a phone's home screen, with its own icon, from the browser. There is no app to download — for you or for your buyers. That was a decision, and it has a cost worth explaining.",
      },
      { type: "h2", text: "The buyer's side is not a close call" },
      {
        type: "p",
        text: "Someone taps a link in a bio because they are curious. Every step you add between that tap and the file loses people, and “install an app first” is the largest step there is. A store that sells to strangers has to work in the browser they already have open.",
      },
      { type: "h2", text: "The creator's side is where it gets interesting" },
      {
        type: "p",
        text: "For running a store on the move — checking sales, answering a buyer — an app on the home screen is genuinely nice. The question is how you get the icon there.",
      },
      {
        type: "ul",
        items: [
          "Through an app store: a native app, a review process for every update, a share of in-app purchases in some cases, and a separate build per platform.",
          "Through the browser: the page declares itself installable, and the phone offers to add it to the home screen. One build, works on iPhone and Android, updates the moment we publish.",
        ],
      },
      {
        type: "p",
        text: "We took the second route because it reaches both phones with one thing to maintain, which for a studio this small is the difference between shipping and not shipping. Stan's own help center says their creator app is currently available only on iPhone and iPad; our installable store runs on both iPhone and Android. That is the concrete difference the choice makes.",
      },
      { type: "h2", text: "The honest cost" },
      {
        type: "p",
        text: "Installing from a browser is less discoverable than a store listing: on iPhone it lives behind the share menu, and on Android behind the browser menu. A native app can also do things a web page cannot, though the gap is closing: since September 27, 2026, the studio itself installs and sends notifications of sales and bookings, but on iPhone only from iOS 16.4 and only once it is on the home screen.",
      },
      {
        type: "note",
        text: "If we ever put a real app in the app stores, this page will say so on the day it is true, and not before. Until then, what you get is a store that installs from the browser menu in a few taps and a buyer who never has to install anything at all.",
      },
    ],
  },
];

/** Preserve existing URLs/content; deepen the existing file guide rather than duplicate its search intent. */
export const BLOG_POSTS:BlogPost[]=BASE_BLOG_POSTS.map(post=>post.slug==="sell-a-digital-file-from-your-bio"?{...post,body:[...post.body,...DIGITAL_FILE_GUIDE_EXTRA],faq:DIGITAL_FILE_GUIDE_FAQ,readMinutes:Math.max(post.readMinutes,7)}:post);

/** The one we point new readers at first. */
export const FEATURED_SLUG = "what-selling-on-gumroad-costs";

/**
 * Newest first. Posts published on the same day keep the order they are
 * written in above, so the list never shuffles between builds.
 */
export function postsSorted(): BlogPost[] {
  return [...BLOG_POSTS].sort((a, b) => b.date.localeCompare(a.date));
}

export function featuredPost(): BlogPost {
  return postBySlug(FEATURED_SLUG) ?? BLOG_POSTS[0];
}

export function postBySlug(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((post) => post.slug === slug);
}

export function formatPostDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
