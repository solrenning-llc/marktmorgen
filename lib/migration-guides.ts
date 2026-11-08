/**
 * "Move from [platform] to Marktmorgen" guides (239 [CF2], unit 1; added 6
 * November 2026). Served at /platform/move-from-<platform> like the existing
 * ClickFunnels guide (lib/feature-pages.ts, "move-from-clickfunnels"), which
 * is not repeated here.
 *
 * Every line under "What comes across on its own" names one of
 * MOVE_CAPABILITIES: an import in lib/imports.ts that starts today on a store
 * with no plan (startProblem), with its own limit (IMPORT_LIMITS). The members
 * import and the one email to past buyers need a paid plan (startProblem:
 * isPaidUp, canSell), so they are never promised; each guide says they wait.
 * A file's figure is not what comes in today: the route also takes every
 * upload from the store's monthly rows, all imports together (takeImportRows,
 * importRowsFor in lib/import-limits.ts), so each guide says that figure too.
 * tests/cf2-move-pages.test.ts holds all of this against the code.
 *
 * The other platform's export steps come from its own help center, read on
 * 6 November 2026 through a web search index: the pages themselves could not
 * be opened from the session that wrote this (the network refused them), so
 * each page says how it was read and sends the creator to the current steps.
 * Teachable's course-export page was also read on 4 November 2026
 * (docs/course-import.md). No account was opened and nobody was contacted.
 */
import type { TopicPage } from "@/lib/site-pages";
import type { IconName } from "@/components/icons";
import { PLANS_ON_SALE } from "@/lib/opening";
import { IMPORT_ALLOWANCES, IMPORT_MIN_ROWS_PER_UPLOAD } from "@/lib/import-limits";

/** The imports a guide may say move on their own, as the studio names them. */
export const MOVE_CAPABILITIES = {
  list: { kind: "contacts", tab: "Your email list", limit: 50_000, start: { agreed: true } },
  products: { kind: "products", tab: "Your products", limit: 500, start: {} },
  pastBuyers: { kind: "purchases", tab: "Your past buyers", limit: 20_000, start: { email: false } },
} as const;
export type MoveCapability = keyof typeof MOVE_CAPABILITIES;

export type MigrationGuide = {
  slug: `move-from-${string}`;
  platform: string;
  /** When its help center was read, as the page says it. */
  checked: string;
  sources: { label: string; href: string }[];
  /** The first of the three steps: how to export there. */
  export: string;
  moves: { capability: MoveCapability; icon: IconName; title: string; body: string }[];
  /** What comes in a month, all imports together, above the lines in `moves`. */
  monthly: string;
  byHand: string[];
  notMoved: string[];
  terms: { term: string; meaning: string }[];
  /** One line on the general moving page. */
  summary: string;
};

const CHECKED = "November 6, 2026";
const n = (capability: MoveCapability) => MOVE_CAPABILITIES[capability].limit.toLocaleString("en-US");
const tabs = { list: MOVE_CAPABILITIES.list.tab, products: MOVE_CAPABILITIES.products.tab, pastBuyers: MOVE_CAPABILITIES.pastBuyers.tab };

/** What waits for a paid plan, said the same way on every guide. */
function waitsForPlan(onSale: boolean): string {
  return onSale
    ? "Members move only while you have a paid plan and your store can take payments. The one email to past buyers also needs a paid plan."
    : "Members, and the one email to past buyers, need a paid plan. Paid plans are not on sale yet, so keep your memberships where they are for now.";
}

/** The rows the import route brings in a month (importRowsFor), said above the file figures. */
function rowsAMonth(onSale: boolean): string {
  const { creator, pro, scale } = IMPORT_ALLOWANCES;
  const r = (v: number) => v.toLocaleString("en-US");
  const which = onSale
    ? `A file can hold the figure on each line, but imports bring in at most ${r(creator.rows)} rows a month on Store, all of them together. Studio brings in ${r(pro.rows)} and Scale ${r(scale.rows)}, and the free trial has Store's figure.`
    : `A file can hold the figure on each line, but imports bring in at most ${r(creator.rows)} rows a month, all of them together. That is the figure with no paid plan, and paid plans are not on sale yet.`;
  return `${which} Each upload counts as at least ${IMPORT_MIN_ROWS_PER_UPLOAD} rows, and a long row can count as more than one. The rest of a bigger file can come in when the next month starts.`;
}

const CSV = { term: "CSV file", meaning: "A spreadsheet saved as plain text, with one row on each line." };
const DRAFT = { term: "Draft", meaning: "A product saved in your studio that buyers cannot see until you publish it." };

export function migrationGuides(onSale = PLANS_ON_SALE): MigrationGuide[] {
  return [
    {
      slug: "move-from-gumroad",
      platform: "Gumroad",
      checked: CHECKED,
      sources: [
        { label: "Gumroad's help center: The sales dashboard", href: "https://gumroad.com/help/article/268-customer-dashboard" },
        { label: "Gumroad's help center: The sales analytics dashboard", href: "https://gumroad.com/help/article/74-the-analytics-dashboard" },
      ],
      export: "Gumroad's help center describes a CSV file of your customers and what they bought, for dates you pick. Its dates are in UTC, so add a day at each end of your dates.",
      moves: [
        { capability: "list", icon: "mail", title: `Your list, up to ${n("list")} a file`, body: `Your buyers' emails, and names where the file has them, under “${tabs.list}”. Bring in only people who agreed to hear from you. You confirm that with a box each time. Nobody is emailed because of the import.` },
        { capability: "pastBuyers", icon: "users", title: `Past buyers, up to ${n("pastBuyers")} a file`, body: `Under “${tabs.pastBuyers}”, each buyer is given what they bought, matched to your product here by its name. No payment is taken and no receipt is sent.` },
        { capability: "products", icon: "tag", title: `Products, up to ${n("products")} a file`, body: `Under “${tabs.products}”, from a spreadsheet with one product on each row: its title, price and description. Each one waits as a draft until you publish it.` },
      ],
      monthly: rowsAMonth(onSale),
      byHand: [
        "Make your products here first. Past buyers are matched to them by their name or ID here.",
        "Add each product's file from its row in the studio. Files are not copied from Gumroad.",
        "Before you import your list, remove each row with a 1 under “Do not contact”. Gumroad's help center says a 1 there means the buyer opted out.",
      ],
      notMoved: [
        waitsForPlan(onSale),
        "Reviews, discount codes, affiliates and license keys do not come across. Buyers brought over get no license key here.",
        "Calls cannot be given to past buyers, and neither can a product with several prices, unless it is a course or a podcast.",
        "Buyers brought over are not sales here. They are not in your numbers, and an import cannot be undone in one step.",
      ],
      terms: [CSV, { term: "UTC", meaning: "Coordinated Universal Time: one clock used for dates around the world." }, DRAFT],
      summary: "Your list and past buyers, from Gumroad's customer file.",
    },
    {
      slug: "move-from-teachable",
      platform: "Teachable",
      checked: CHECKED,
      sources: [
        { label: "Teachable's help center: How to export school content and data", href: "https://support.teachable.com/en/articles/12053250-how-to-export-school-content-and-data" },
        { label: "Teachable's help center: Users", href: "https://support.teachable.com/en/articles/11682398-users" },
        { label: "Teachable's help center: Transaction history and reports", href: "https://support.teachable.com/en/articles/11682567-transaction-history-and-reports" },
      ],
      export: "Teachable's help center describes two CSV files from your school's admin: your users and your transactions. It emails the users file to the school owner, so check your inbox.",
      moves: [
        { capability: "list", icon: "mail", title: `Your list, up to ${n("list")} a file`, body: `From the users file, under “${tabs.list}”: each person's email and name. Bring in only people who agreed to hear from you. You confirm that with a box each time. Nobody is emailed because of the import.` },
        { capability: "pastBuyers", icon: "users", title: `Past students, up to ${n("pastBuyers")} a file`, body: `From the transactions file, under “${tabs.pastBuyers}”: each buyer is given the course they bought, matched to your course here by its name. No payment is taken and no receipt is sent.` },
        { capability: "products", icon: "tag", title: `Products, up to ${n("products")} a file`, body: `Under “${tabs.products}”, from a spreadsheet with one product on each row: its title, price and description. Each one waits as a draft until you publish it.` },
      ],
      monthly: rowsAMonth(onSale),
      byHand: [
        "Make each course here first. Past students are matched to it by its name or ID here.",
        "Rebuild each course's lessons. Teachable's help center says there is no export of a whole course, so you download videos and files one by one. Here, you add a course's videos as lessons.",
        "Before you import your list, remove anyone the users file marks as opted out of marketing.",
      ],
      notMoved: [
        waitsForPlan(onSale),
        "Quizzes, certificates, comments and each student's progress do not come across.",
        "Calls cannot be given to past students, and neither can a product with several prices, unless it is a course or a podcast.",
        "Students brought over are not sales here. They are not in your numbers, and an import cannot be undone in one step.",
      ],
      terms: [CSV, DRAFT],
      summary: "Your list and past students, from Teachable's users and transactions files.",
    },
  ];
}

export const MIGRATION_GUIDES = migrationGuides();

/** The guide as a page under /platform, with no menu entry of its own. */
export function migrationGuidePage(guide: MigrationGuide): TopicPage {
  const p = guide.platform;
  return {
    slug: guide.slug,
    section: "platform",
    eyebrow: `Moving from ${p}`,
    title: `Move from ${p}`,
    highlight: "to Marktmorgen",
    intro: `What comes across from ${p} on its own, what you redo by hand, and what stays behind. Each step is what our import does today.`,
    seo: { title: `Move from ${p} to Marktmorgen: a step-by-step guide`, description: `How to bring your list and past buyers from ${p} to Marktmorgen, what you redo by hand, and what does not come across.` },
    visual: "importDone",
    badge: { label: "Working today", tone: "live" },
    accent: "from-violet-brand to-sky-brand",
    plan: "creator",
    blocks: [
      {
        kind: "how",
        title: `How a move from ${p} works`,
        items: [
          { title: `Export from ${p}`, body: guide.export },
          { title: "Match the columns", body: "In your studio, open “Moving from another platform” and press “Choose a CSV file”. The studio guesses each column. Check them under “Which column is which”." },
          { title: "Import", body: "Look over “The first rows, as they will be read”, then press Import. Each row left out is listed with its row number and the reason." },
        ],
      },
      { kind: "features", title: "What comes across on its own", intro: guide.monthly, items: guide.moves.map(({ icon, title, body }) => ({ icon, title, body })) },
      { kind: "limits", title: "What you redo by hand", items: guide.byHand },
      { kind: "limits", title: "What does not come across", items: guide.notMoved },
      { kind: "terms", title: "Words on this page", items: guide.terms },
      {
        kind: "features",
        title: `Where the ${p} steps come from`,
        intro: `We read these pages as a search engine showed them on ${guide.checked}. Menus change, so follow the current steps there. ${p} is a trademark of its owner. Marktmorgen is not affiliated with it.`,
        items: guide.sources.map((s) => ({ icon: "book" as IconName, title: s.label, body: `Opens ${p}'s own help page.`, href: s.href })),
      },
    ],
  };
}

export const MIGRATION_GUIDE_PAGES: TopicPage[] = MIGRATION_GUIDES.map(migrationGuidePage);
