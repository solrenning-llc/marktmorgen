/**
 * What the Marktmorgen MCP server offers, written once (631 [AA1] (b), unit 5,
 * 2 November 2026): the protocol version, the server's name, its instructions
 * and every tool with its description and input. app/api/mcp/route.ts answers
 * `initialize` and `tools/list` from here, and /llms.txt (app/llms.txt/route.ts)
 * is generated from the same list, so the documentation an agent reads can
 * never name a tool the server does not serve, or miss one it does.
 *
 * Moved here unchanged from app/api/mcp/route.ts, where the tools themselves
 * are still dispatched.
 */
type ToolDraft = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean };
  annotations: { readOnlyHint: boolean };
};

/**
 * A tool as served, with a human title beside its name (MCP's `title`, also
 * in `annotations.title`): connector directories show it, and Anthropic's
 * asks every tool for a title and a read-only or destructive hint (unit 8,
 * 2 November 2026).
 */
export type McpTool = Omit<ToolDraft, "annotations"> & { title: string; annotations: { readOnlyHint: boolean; title: string } };

const TITLES: Readonly<Record<string, string>> = {
  get_numbers: "Store numbers",
  list_products: "List products",
  get_revenue_by_channel: "Revenue by channel",
  get_funnel: "Visit-to-sale funnel",
  get_product_numbers: "Product numbers",
  get_buyers: "Buyers in numbers",
  get_worth_knowing: "Worth knowing",
  get_memberships: "Membership numbers",
  get_emails: "Emails and sequences",
  get_affiliates: "Affiliates",
  get_live: "Live and today",
  get_numbers_for_days: "Numbers for any days",
  get_product_description: "Product description",
  get_sales_page: "Sales page",
  get_course_outline: "Course outline",
  get_lesson: "Course lesson",
  get_page_test: "Page test",
  get_page_reading: "How far the page is read",
  get_page_versions: "Earlier page versions",
  list_saved_blocks: "Saved sections",
  list_bundle_choices: "Products for a bundle",
  get_imports: "Imports",
  propose_product_description: "Propose a product description",
  propose_product_title: "Propose a product title",
  propose_product_summary: "Propose a product summary",
  get_store: "Which store",
};

export const MCP_SERVER = { name: "marktmorgen", version: "1.1.0" } as const;

export const MCP_INSTRUCTIONS =
  "Read a Marktmorgen store's numbers, products, memberships, emails and affiliate program, never anybody's name or address. Money fields are in the smallest unit of the store's currency. A channel named 'direct' is a visit or sale from nowhere the store could name. Tools that take `days` read the last 7, 30 or 90 days.";

export const MCP_PROTOCOL = "2025-06-18";

const DRAFTS: readonly ToolDraft[] = [
  {
    name: "get_numbers",
    description:
      "The store's numbers for the last 7, 30 and 90 days: visitors, checkouts, sales and revenue; each channel (instagram, tiktok, newsletter…) from visit to sale; and page views by country and device, each window with the same stretch of days just before it under previous. Money is in the smallest unit of the store's currency (cents for USD), before Stripe's fee.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_products",
    description: "The store's products in the order the store shows them, drafts included, 50 at a time. Pass the returned `next` as `cursor` for more.",
    inputSchema: { type: "object", properties: { cursor: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  ...(
    [
      ["get_revenue_by_channel", "Revenue by channel for the last 7, 30 or 90 days: each channel's visits, checkouts, free sign-ups, sales and revenue; the same money credited three ways (last visit, first visit, what buyers said after paying); and money by ad and by post."],
      ["get_funnel", "From visit to sale for the last 7, 30 or 90 days, with the same stretch of days before, the rates between each step, and how far down the store page visitors read and what they clicked."],
      ["get_product_numbers", "Each product for the last 7, 30 or 90 days: page views, checkouts, sales, revenue and sales per view; and, from all sales, which product is bought first and what buyers buy next, how many and how many days later."],
      ["get_buyers", "Who bought in the last 7, 30 or 90 days, in numbers only: people, orders, revenue, how many had bought before and how many bought more than once. No names or addresses."],
      ["get_worth_knowing", "What changed in the last 7, 30 or 90 days that is worth acting on, by the studio's own fixed rules, with the arithmetic behind any money at stake."],
    ] as const
  ).map(([name, description]) => ({
    name,
    description,
    inputSchema: { type: "object", properties: { days: { type: "number", enum: [7, 30, 90], description: "The window; 30 when left out." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  })),
  {
    name: "get_memberships",
    description: "Memberships as the Membership numbers page shows them: MRR and ARR, paying and trialing members, churn, trials that converted, each membership, each channel's members and how long they stay, why members left (counted), MRR month by month by what moved it, ARPU, net revenue retention and a three-month forecast.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_emails",
    description: "The store's list (how many people, how many agreed to hear) and what each email and each sequence did: how many it went to, and the sales and revenue its links brought, in the store's currency, with sales_in_another_currency counted apart and never added to revenue.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_affiliates",
    description: "The affiliate program's terms and each affiliate by their link's code: clicks, sales, earned, paid, owed, payable now, and anything held for review and why. No addresses.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_live",
    description: "Who is on the store right now (visitors in the last few minutes, each once, by where they came from) and today so far: visitors, page views, checkouts started, sales and revenue. No visitor is identified.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_numbers_for_days",
    description: "The store's numbers for any stretch of UTC days, up to 400 days back: visitors, page views, checkouts, sales and revenue, day by day, by channel and by product, beside the same number of days just before. Paid figures are null when the sales reading was incomplete.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "The first day, YYYY-MM-DD (UTC)." },
        to: { type: "string", description: "The last day, YYYY-MM-DD (UTC), not after today." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_product_description",
    description: "One product's long description, exactly as the creator wrote it, with its title. Use list_products for the ids.",
    inputSchema: { type: "object", properties: { product: { type: "string", description: "The product's id, from list_products." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_sales_page",
    description: "One product's sales page as saved, block by block in page order (hero, benefits, FAQ, guarantee and the rest), with its search title and description. Testimonials are counted, never quoted.",
    inputSchema: { type: "object", properties: { product: { type: "string", description: "The product's id, from list_products." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_course_outline",
    description: "A course's modules and lessons in order, with each lesson's title, whether it is a free preview, whether it has text, its video and files by name, and when each module opens.",
    inputSchema: { type: "object", properties: { product: { type: "string", description: "The course's product id, from list_products." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_lesson",
    description: "One lesson of a course as the creator wrote it: its text, its quiz with the right answers, and its task.",
    inputSchema: {
      type: "object",
      properties: {
        product: { type: "string", description: "The course's product id, from list_products." },
        lesson: { type: "string", description: "The lesson's id, from get_course_outline." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_page_test",
    description: "How a product's page test is going (a second headline or a second version of the whole page): views, checkouts, sales and money of each version, and whether it has been won by the studio's own rule.",
    inputSchema: { type: "object", properties: { product: { type: "string", description: "The product's id, from list_products." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_page_reading",
    description: "How far down a product's sales page visitors read, block by block, the reasons visitors picked for not buying, and how far each video was watched.",
    inputSchema: { type: "object", properties: { product: { type: "string", description: "The product's id, from list_products." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_page_versions",
    description: "A product's sales page as it was before its last saves: the list of earlier versions, newest first, or one version block by block. Testimonials are counted, never quoted.",
    inputSchema: {
      type: "object",
      properties: {
        product: { type: "string", description: "The product's id, from list_products." },
        version: { type: "number", description: "Which earlier version, from the list (0 is the newest); left out, the list." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_saved_blocks",
    description: "The sections the creator saved to reuse on any page, each with its name and its blocks, newest change first. Testimonials are counted, never quoted.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_bundle_choices",
    description:
      "The store's products a bundle may be made of, 20 a page in the creator's order, each with whether it can go in and why it cannot (a membership, a call, several prices, free, a limited number, nothing to hand over yet), by the same rule as the creator's bundle picker. Each call reads one page; pass cursor: next_cursor from the last answer for the next one, until next_cursor is null.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Words in the product's name; left out, every product." },
        cursor: { type: "string", description: "Where the page starts: next_cursor from the previous answer; left out, the first page." },
        bundle: { type: "string", description: "The bundle being made, from list_products, left out of its own list." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_imports",
    description:
      "The store's latest imports from another platform (contacts, products, purchases or members), newest first: how far each is and what its rows came to, as counts. Never the file's name, who started it or the rows themselves.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "propose_product_description",
    description:
      "Prepares a new long description for one product, for the creator to read beside the current one and confirm in their studio (What the AI proposes). Nothing on the store changes until they confirm; they can undo it afterward. Needs a key that may prepare changes. A newer proposal for the same product replaces a waiting one.",
    inputSchema: {
      type: "object",
      properties: {
        product: { type: "string", description: "The product's id, from list_products." },
        description: { type: "string", description: "The whole new description as plain text: a blank line starts a paragraph, a line starting with \"- \" is a point in a list." },
      },
      required: ["product", "description"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "propose_product_title",
    description:
      "Prepares a new title for one product, for the creator to read beside the current one and confirm in their studio (What the AI proposes). Its price and everything else stay as they are. Nothing on the store changes until they confirm; they can undo it afterward. Needs a key that may prepare changes. A newer proposal for the same product replaces a waiting one.",
    inputSchema: {
      type: "object",
      properties: {
        product: { type: "string", description: "The product's id, from list_products." },
        title: { type: "string", description: "The whole new title, on one line." },
      },
      required: ["product", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "propose_product_summary",
    description:
      "Prepares a new short summary for one product (the line under its title), for the creator to read beside the current one and confirm in their studio (What the AI proposes). Its price and everything else stay as they are. Nothing on the store changes until they confirm; they can undo it afterward. Needs a key that may prepare changes. A newer proposal for the same product replaces a waiting one.",
    inputSchema: {
      type: "object",
      properties: {
        product: { type: "string", description: "The product's id, from list_products." },
        summary: { type: "string", description: "The whole new summary, on one line; empty takes it off." },
      },
      required: ["product", "summary"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "get_store",
    description: "Which store this key reads: its handle, name and currency.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

/** Every tool, with its title; a tool without one fails the tests rather than shipping untitled. */
export const MCP_TOOLS: readonly McpTool[] = DRAFTS.map((tool) => {
  const title = TITLES[tool.name] ?? "";
  return { ...tool, title, annotations: { ...tool.annotations, title } };
});
