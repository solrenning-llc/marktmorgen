/**
 * Starter funnels (added 17 October 2026): whole funnels with Marktmorgen's
 * own starting words, in the same file format a creator shares
 * (lib/funnel-bundle.ts), so a starter is previewed, mapped to the
 * creator's products and checked exactly like a shared funnel.
 *
 * The funnel types (lib/funnel-types.ts) make empty pages under a title. A
 * starter goes one step further and writes a first draft of the words:
 * headings, the steps of what happens next, the questions buyers ask. Every
 * sentence is one a creator can say truthfully as it stands, or is a
 * placeholder in [brackets] for what only they know. None states a result,
 * a number, a deadline or what somebody said about them, and the pages
 * arrive kept back from visitors until the creator has made them theirs.
 */
import { BUNDLE_FORMAT, BUNDLE_SCHEMA, outlineOf, type BundleOutline, type FunnelBundle, type PlanLine } from "@/lib/funnel-bundle";

export type FunnelStarter = {
  id: string;
  label: string;
  hint: string;
  bundle: FunnelBundle;
  /**
   * What the creator is told to do first, said in its preview before the
   * parts to fill in (starterOutline) and again in the list of what to do
   * once it is made (starterBeforeLines). A starter's own, never part of a
   * shared file.
   */
  before?: string[];
};

const nextSteps = (first: { title: string; detail: string }) => ({
  ref: "p2",
  title: "What happens next",
  slug: "what-happens-next",
  target: "",
  style: "plain" as const,
  blocks: [
    { id: "nx01", kind: "hero" as const, headline: "Thank you. Here is what happens next", sub: "", media: "none" as const, video: null },
    {
      id: "nx02",
      kind: "steps" as const,
      heading: "Your next steps",
      items: [
        first,
        { title: "Start here", detail: "[Tell them where to begin and the first thing to do.]" },
        { title: "Get in touch", detail: "[Tell them how to reach you with a question.]" },
      ],
    },
    { id: "nx03", kind: "cta" as const, label: "Visit the store", note: "" },
  ],
});

export const FUNNEL_STARTERS: FunnelStarter[] = [
  {
    id: "guide-signup",
    label: "Free guide, then your first offer",
    hint: "A page about your free guide, the guide's own sign-up page, your first paid product, and a page that says what happens next.",
    bundle: {
      format: BUNDLE_FORMAT,
      schema: BUNDLE_SCHEMA,
      name: "Free guide",
      products: [
        { ref: "x1", label: "Your free guide", wants: "free" },
        { ref: "x2", label: "Your first paid product", wants: "paid" },
      ],
      forms: [],
      steps: [
        { kind: "page", ref: "p1" },
        { kind: "product", ref: "x1" },
        { kind: "product", ref: "x2" },
        { kind: "page", ref: "p2" },
      ],
      pages: [
        {
          ref: "p1",
          title: "Free guide",
          slug: "free-guide",
          target: "x1",
          style: "plain",
          blocks: [
            {
              id: "gs01",
              kind: "hero",
              headline: "A free guide to [your topic]",
              sub: "A short, practical guide you can read in one sitting. It is free: enter your email on the next page and the download link comes to your inbox.",
              media: "none",
              video: null,
              button: true,
            },
            { id: "gs02", kind: "benefits", heading: "What the guide covers", items: ["[The first thing it helps with]", "[The second thing it helps with]", "[The third thing it helps with]"] },
            { id: "gs03", kind: "bio", heading: "", body: "", photo: true },
            {
              id: "gs04",
              kind: "faq",
              heading: "Questions",
              items: [
                { q: "Is it really free?", a: "Yes. You enter your email address and the download link is sent to it." },
                { q: "Will I get other emails?", a: "[Say whether you will email them again, about what, and that they can unsubscribe at any time.]" },
              ],
            },
            { id: "gs05", kind: "cta", label: "Get the free guide", note: "" },
          ],
        },
        nextSteps({ title: "Check your email", detail: "Your download link is on its way. If it is not there in a few minutes, look in your spam or promotions folder." }),
      ],
    },
  },
  {
    id: "recorded-workshop",
    label: "Recorded workshop",
    hint: "A page with a recorded workshop that leads to your program, its sales page, and a page that says what happens next. Recorded, and called recorded.",
    bundle: {
      format: BUNDLE_FORMAT,
      schema: BUNDLE_SCHEMA,
      name: "Recorded workshop",
      products: [{ ref: "x1", label: "The program the workshop leads to", wants: "paid" }],
      forms: [],
      steps: [
        { kind: "page", ref: "p1" },
        { kind: "product", ref: "x1" },
        { kind: "page", ref: "p2" },
      ],
      pages: [
        {
          ref: "p1",
          title: "Free workshop",
          slug: "free-workshop",
          target: "x1",
          style: "bands",
          blocks: [
            { id: "rw01", kind: "hero", headline: "Watch the free workshop: [your topic]", sub: "A recorded workshop of about [length] minutes. Watch it whenever suits you.", media: "none", video: null },
            { id: "rw02", kind: "video", heading: "The workshop", video: null, caption: "" },
            { id: "rw03", kind: "text", heading: "What we cover", body: "- [The first point]\n- [The second point]\n- [The third point]" },
            { id: "rw04", kind: "bio", heading: "", body: "", photo: true },
            { id: "rw05", kind: "cta", label: "See the full program", note: "" },
          ],
        },
        nextSteps({ title: "Check your email", detail: "Your receipt and how to get started are in your inbox." }),
      ],
    },
  },
  {
    id: "coaching-application",
    label: "Coaching application",
    hint: "A page that says who you work with and how, with an application form, and a page that says what happens after applying. You read each application and decide whom to answer.",
    bundle: {
      format: BUNDLE_FORMAT,
      schema: BUNDLE_SCHEMA,
      name: "Coaching application",
      products: [],
      forms: [
        {
          ref: "f1",
          name: "Application",
          fields: [
            { id: "apnm01", type: "short", label: "Your name", required: true, options: [] },
            { id: "apem01", type: "email", label: "Your email", required: true, options: [] },
            { id: "aphl01", type: "long", label: "What would you like help with?", required: true, options: [] },
            { id: "aptr01", type: "long", label: "What have you tried so far?", required: false, options: [] },
          ],
          button: "Send my application",
          doneHeading: "Thank you, your application is in",
          doneBody: "[Tell them when and how you reply to applications.]",
          outcomes: [],
          offerList: false,
        },
      ],
      steps: [
        { kind: "page", ref: "p1" },
        { kind: "page", ref: "p2" },
      ],
      pages: [
        {
          ref: "p1",
          title: "Work with me",
          slug: "work-with-me",
          target: "",
          style: "cards",
          blocks: [
            { id: "ca01", kind: "hero", headline: "Apply to work with me", sub: "[Who you help, and with what.] Answer a few questions so we can both see whether it is a good fit.", media: "none", video: null },
            { id: "ca02", kind: "fit", heading: "Is this for you?", yesLabel: "A good fit if you", noLabel: "Not the right fit if you", yes: ["[Describe who you work best with]"], no: ["[Describe who you are not the right person for]"] },
            {
              id: "ca03",
              kind: "steps",
              heading: "How it works",
              items: [
                { title: "Apply", detail: "Answer the questions on this page. It takes a few minutes." },
                { title: "Talk", detail: "[What happens if it looks like a fit, for example a short call.]" },
                { title: "Start", detail: "[What working together looks like.]" },
              ],
            },
            { id: "ca04", kind: "form", heading: "Your application", form: "f1" },
            {
              id: "ca05",
              kind: "faq",
              heading: "Questions",
              items: [
                { q: "What does it cost?", a: "[Your answer.]" },
                { q: "How do we meet?", a: "[Your answer.]" },
              ],
            },
          ],
        },
        {
          ref: "p2",
          title: "After you apply",
          slug: "after-you-apply",
          target: "",
          style: "plain",
          blocks: [
            { id: "aa01", kind: "hero", headline: "Thank you for applying", sub: "", media: "none", video: null },
            { id: "aa02", kind: "text", heading: "What happens now", body: "[Say when you read applications and how you reply.]" },
            { id: "aa03", kind: "cta", label: "Visit the store", note: "" },
          ],
        },
      ],
    },
  },
  {
    id: "membership",
    label: "Membership, with a page that sells it",
    hint: "A page about your membership, the membership itself, and a page that says what happens after joining.",
    bundle: {
      format: BUNDLE_FORMAT,
      schema: BUNDLE_SCHEMA,
      name: "Membership",
      products: [{ ref: "x1", label: "Your membership", wants: "paid" }],
      forms: [],
      steps: [
        { kind: "page", ref: "p1" },
        { kind: "product", ref: "x1" },
        { kind: "page", ref: "p2" },
      ],
      pages: [
        {
          ref: "p1",
          title: "Membership",
          slug: "membership",
          target: "x1",
          style: "bands",
          blocks: [
            { id: "mb01", kind: "hero", headline: "Join [the name of your membership]", sub: "[Who it is for, and what members get each month.] Members can cancel on their own, at the end of the period they paid for.", media: "none", video: null, button: true },
            { id: "mb02", kind: "benefits", heading: "What members get", items: ["[The first thing members get]", "[The second thing members get]", "[How often something new arrives]"] },
            { id: "mb03", kind: "fit", heading: "Is it for you?", yesLabel: "Right for you if you", noLabel: "Not right for you if you", yes: ["[Describe who it suits]"], no: ["[Describe who it does not suit]"] },
            { id: "mb04", kind: "bio", heading: "", body: "", photo: true },
            {
              id: "mb05",
              kind: "faq",
              heading: "Questions",
              items: [
                { q: "How do I cancel?", a: "Under the membership on this store, press Manage or cancel and follow the emailed link. It ends at the end of the period you paid for." },
                { q: "What happens after I join?", a: "[Tell them where they find everything and what to do first.]" },
              ],
            },
            { id: "mb06", kind: "cta", label: "Join the membership", note: "" },
          ],
        },
        nextSteps({ title: "Check your email", detail: "Your receipt and how to get in are in your inbox." }),
      ],
    },
  },
  {
    id: "course-free-lesson",
    label: "Free lesson, then the course",
    hint: "A page about a free lesson, the lesson's own sign-up page, the full course, and a page that says what happens next.",
    bundle: {
      format: BUNDLE_FORMAT,
      schema: BUNDLE_SCHEMA,
      name: "Free lesson",
      products: [
        { ref: "x1", label: "Your free lesson", wants: "free" },
        { ref: "x2", label: "Your full course", wants: "paid" },
      ],
      forms: [],
      steps: [
        { kind: "page", ref: "p1" },
        { kind: "product", ref: "x1" },
        { kind: "product", ref: "x2" },
        { kind: "page", ref: "p2" },
      ],
      pages: [
        {
          ref: "p1",
          title: "Free lesson",
          slug: "free-lesson",
          target: "x1",
          style: "plain",
          blocks: [
            { id: "fl01", kind: "hero", headline: "A free lesson from [your course]", sub: "The first lesson of the course, free. Enter your email on the next page and the link comes to your inbox.", media: "none", video: null, button: true },
            { id: "fl02", kind: "text", heading: "In this lesson", body: "- [The first thing it covers]\n- [The second thing it covers]" },
            { id: "fl03", kind: "text", heading: "In the full course", body: "[Say what the rest of the course covers, how many lessons it has, and how long it takes.]" },
            { id: "fl04", kind: "bio", heading: "", body: "", photo: true },
            { id: "fl05", kind: "cta", label: "Get the free lesson", note: "" },
          ],
        },
        nextSteps({ title: "Check your email", detail: "Your link is on its way. If it is not there in a few minutes, look in your spam or promotions folder." }),
      ],
    },
  },
  {
    id: "paid-call",
    label: "A paid call",
    hint: "A page about a call with you, the call itself to book and pay for, and a page that says how to prepare.",
    bundle: {
      format: BUNDLE_FORMAT,
      schema: BUNDLE_SCHEMA,
      name: "Paid call",
      products: [{ ref: "x1", label: "Your call", wants: "paid" }],
      forms: [],
      steps: [
        { kind: "page", ref: "p1" },
        { kind: "product", ref: "x1" },
        { kind: "page", ref: "p2" },
      ],
      pages: [
        {
          ref: "p1",
          title: "Book a call",
          slug: "book-a-call",
          target: "x1",
          style: "cards",
          blocks: [
            { id: "pc01", kind: "hero", headline: "A [length]-minute call with me about [your topic]", sub: "[Who it is for, and what you will look at together.] Pick a time that suits you when you book.", media: "none", video: null, button: true },
            {
              id: "pc02",
              kind: "steps",
              heading: "How it works",
              items: [
                { title: "Book", detail: "Choose a time and pay. The meeting link comes with your confirmation." },
                { title: "Prepare", detail: "[Tell them what to bring or send before the call.]" },
                { title: "Talk", detail: "[Say what happens on the call and what they leave with.]" },
              ],
            },
            { id: "pc03", kind: "fit", heading: "Is it for you?", yesLabel: "Book if you", noLabel: "Not the right call if you", yes: ["[Describe who it helps]"], no: ["[Describe who it does not help]"] },
            {
              id: "pc04",
              kind: "faq",
              heading: "Questions",
              items: [
                { q: "Can I move my booking?", a: "[Say whether and until when they can move it.]" },
                { q: "Is it recorded?", a: "[Your answer.]" },
              ],
            },
            { id: "pc05", kind: "cta", label: "Book the call", note: "" },
          ],
        },
        nextSteps({ title: "Check your email", detail: "Your booking, its time and the meeting link are in your inbox." }),
      ],
    },
  },
];

// Campaigns use the same strict reader, product mapping and draft-only import
// as shared funnels. No new sending, AI or storage path is introduced.
FUNNEL_STARTERS.push(
  {
    id: "digital-product",
    label: "Sell a digital product",
    hint: "Explain your download or toolkit, answer buying questions, and lead to its checkout and getting-started page.",
    bundle: {
      format: BUNDLE_FORMAT, schema: BUNDLE_SCHEMA, name: "Digital product",
      products: [{ ref: "x1", label: "Your download or toolkit", wants: "paid" }],
      forms: [],
      steps: [{ kind: "page", ref: "p1" }, { kind: "product", ref: "x1" }, { kind: "page", ref: "p2" }],
      pages: [
        {
          ref: "p1", title: "Your digital product", slug: "digital-product", target: "x1", style: "cards",
          blocks: [
            { id: "dp01", kind: "hero", headline: "[Your product] for [the people it helps]", sub: "[Explain what it helps someone do and the format they receive.]", media: "none", video: null, button: true },
            { id: "dp02", kind: "benefits", heading: "What is inside", items: ["[The first file, template or resource]", "[The second file, template or resource]", "[Instructions or examples included]"] },
            { id: "dp03", kind: "fit", heading: "Before you buy", yesLabel: "Useful if you", noLabel: "Not a fit if you", yes: ["[Who can use this and what they need]"], no: ["[What this product does not do]"] },
            { id: "dp04", kind: "steps", heading: "How to use it", items: [{ title: "Get your files", detail: "[Say how the files are delivered.]" }, { title: "Open and start", detail: "[Name any software required and the first thing to do.]" }, { title: "Ask a question", detail: "[Explain what support is included and how to reach you.]" }] },
            { id: "dp05", kind: "faq", heading: "Buying questions", items: [{ q: "What format is it?", a: "[List file formats, required tools and any compatibility limits.]" }, { q: "How may I use it?", a: "[Explain personal or commercial use, sharing and license terms.]" }, { q: "What is the refund policy?", a: "[State the policy that applies to this product.]" }] },
            { id: "dp06", kind: "cta", label: "See the product and price", note: "" },
          ],
        },
        nextSteps({ title: "Get your product", detail: "[Tell the buyer where their files are and how to open them.]" }),
      ],
    },
  },
  {
    id: "launch-waitlist",
    label: "Build a launch waitlist",
    hint: "Describe what you are preparing and collect interested people's details, without taking payment or promising an unannounced launch date.",
    bundle: {
      format: BUNDLE_FORMAT, schema: BUNDLE_SCHEMA, name: "Launch waitlist",
      products: [],
      forms: [{
        ref: "f1", name: "Launch interest",
        fields: [
          { id: "lwnm01", type: "short", label: "Your name", required: false, options: [] },
          { id: "lwem01", type: "email", label: "Your email", required: true, options: [] },
          { id: "lwhp01", type: "long", label: "What would you like this to help you with?", required: false, options: [] },
        ],
        button: "Register my interest", doneHeading: "Your interest is recorded",
        doneBody: "[Explain whether and how you will reply. This form does not reserve a place or take payment.]",
        outcomes: [], offerList: false,
      }],
      steps: [{ kind: "page", ref: "p1" }, { kind: "page", ref: "p2" }],
      pages: [
        {
          ref: "p1", title: "Coming next", slug: "launch-interest", target: "", style: "plain",
          blocks: [
            { id: "lw01", kind: "hero", headline: "I am preparing [your offer]", sub: "[Describe what you are working on and who it is for.] Register your interest below. No payment is taken.", media: "none", video: null },
            { id: "lw02", kind: "benefits", heading: "What I am working on", items: ["[The first part you plan to include]", "[The second part you plan to include]", "[What is still being decided]"] },
            { id: "lw03", kind: "text", heading: "About your details", body: "[Explain how you will use these answers, who can access them and how to ask for their deletion. If you offer marketing updates, configure the separate optional mailing-list choice before publishing.]" },
            { id: "lw04", kind: "form", heading: "Register your interest", form: "f1" },
            { id: "lw05", kind: "faq", heading: "Questions", items: [{ q: "Does this reserve a place?", a: "No. This records your interest. It is not a booking or purchase." }, { q: "When will it be ready?", a: "[Say what you can confirm today. Leave out dates you cannot confirm.]" }] },
          ],
        },
        {
          ref: "p2", title: "After registering interest", slug: "after-registering-interest", target: "", style: "plain",
          blocks: [
            { id: "li01", kind: "hero", headline: "What happens after registering interest", sub: "[Explain your next step and whether you will contact them.]", media: "none", video: null },
            { id: "li02", kind: "text", heading: "No payment or reservation", body: "Registering interest is not a booking or purchase. [Explain how someone can update or remove their details.]" },
            { id: "li03", kind: "cta", label: "Visit the store", note: "" },
          ],
        },
      ],
    },
  },
  {
    id: "course-launch",
    label: "Launch a complete course",
    hint: "Present the curriculum, required experience, teaching format and support before sending learners to your course checkout.",
    bundle: {
      format: BUNDLE_FORMAT, schema: BUNDLE_SCHEMA, name: "Course launch",
      products: [{ ref: "x1", label: "Your complete course", wants: "paid" }], forms: [],
      steps: [{ kind: "page", ref: "p1" }, { kind: "product", ref: "x1" }, { kind: "page", ref: "p2" }],
      pages: [
        {
          ref: "p1", title: "About the course", slug: "about-the-course", target: "x1", style: "bands",
          blocks: [
            { id: "cl01", kind: "hero", headline: "Learn [your subject] with [your course]", sub: "[Explain who it is for, what it teaches and the format.]", media: "none", video: null, button: true },
            { id: "cl02", kind: "steps", heading: "Inside the curriculum", items: [{ title: "[First module]", detail: "[What learners study and practise here.]" }, { title: "[Second module]", detail: "[What learners study and practise here.]" }, { title: "[Final module]", detail: "[What learners study and practise here.]" }] },
            { id: "cl03", kind: "fit", heading: "Choose the right course for you", yesLabel: "Designed for you if you", noLabel: "Choose something else if you", yes: ["[Experience, equipment and time needed]"], no: ["[Topics or support this course does not include]"] },
            { id: "cl04", kind: "bio", heading: "About your teacher", body: "", photo: true },
            { id: "cl05", kind: "faq", heading: "Before enrolling", items: [{ q: "How are lessons delivered?", a: "[Explain recorded or live lessons, release dates and how long access lasts.]" }, { q: "What support is included?", a: "[Explain questions, feedback and any calls included.]" }, { q: "Can I get a refund?", a: "[State the refund policy that applies to this course.]" }] },
            { id: "cl06", kind: "cta", label: "See the course and enrollment options", note: "" },
          ],
        },
        nextSteps({ title: "Open your course", detail: "[Explain where to sign in, which lesson to start with and what to prepare.]" }),
      ],
    },
  },
);

// 242 [CF5], unit 3 (added 2 November 2026): for a creator who ships what
// they sell. Where it ships, what shipping costs and when it ships are never
// written for them: the product's page and the checkout show those from its
// shipping settings (components/store-product.tsx, lib/store-checkout.ts),
// and the campaign's own answers are parts in [brackets] for the creator's
// words. Which product ships is not known without reading each one in full,
// so the preview and the list after it is made say, every time, which
// products can ship and how to turn it on (lib/shipping.ts, shipProblem). No
// health, beauty or other result, no rating, badge or "best seller", no
// delivery date.
const SHIP_FIRST =
  "Choose a product you ship. Only a paid product bought once can ship. A membership, a call, a bundle, a payment plan or a price the buyer chooses cannot. Neither can a product with a file, link, course or podcast to hand over. In its editor, turn on “Ship it: a physical product, sent by you”. Its page then shows what shipping costs and where it ships. The checkout asks for an address.";
FUNNEL_STARTERS.push({
  id: "physical-product",
  label: "Sell something you ship",
  hint: "Show what comes in the box, its size and materials, and how shipping and returns work, then lead to the product you ship.",
  before: [SHIP_FIRST],
  bundle: {
    format: BUNDLE_FORMAT, schema: BUNDLE_SCHEMA, name: "Something you ship",
    products: [{ ref: "x1", label: "The product you ship", wants: "paid" }],
    forms: [],
    steps: [{ kind: "page", ref: "p1" }, { kind: "product", ref: "x1" }, { kind: "page", ref: "p2" }],
    pages: [
      {
        ref: "p1", title: "Your product", slug: "your-product", target: "x1", style: "cards",
        blocks: [
          { id: "sp01", kind: "hero", headline: "[Your product]: [what it is, in a few words]", sub: "[Say what it is, what it is made of and who it is for.]", media: "none", video: null, button: true },
          { id: "sp02", kind: "benefits", heading: "What comes in the box", items: ["[The first thing in the box]", "[The next thing in the box]"] },
          { id: "sp03", kind: "text", heading: "Size and materials", body: "[Give its measurements and weight, what it is made of and how to look after it. Say anything it needs that is not in the box.]" },
          { id: "sp04", kind: "faq", heading: "Before you order", items: [
            { q: "Where does it ship, and what does shipping cost?", a: "[Say where you ship and what shipping costs, as your shipping settings say. The product's page and the checkout show both from there.]" },
            { q: "When does it ship?", a: "[Say when you ship it, in the same words as the note in your shipping settings.]" },
            { q: "Can I return or exchange it?", a: "[Say how returns and exchanges work, as your refund policy says.]" },
          ] },
          { id: "sp05", kind: "cta", label: "See the product and price", note: "" },
        ],
      },
      nextSteps({ title: "Your order", detail: "[Tell the buyer when you will send it and how they will hear from you.]" }),
    ],
  },
});

// 242 [CF5], unit 4 (added 2 November 2026): four more campaigns of the
// owner's complement of 29 October 2026 for what a creator ships; handmade
// pieces, printed art and pet products use "Sell something you ship" above.
// Built as that one: the product's page with what comes in it, its own details and the
// same questions before ordering, every shipping fact in the creator's words,
// and turning shipping on said first. Food also says, first, what only the
// creator can check: no rule of any country is stated or promised here.
const FOOD_RULES =
  "Before you sell food, check the rules where you make it and where you ship it. Check whether you may sell and ship it from there. Check what its label must say and which ingredients and allergens to list. Check how long it keeps and how it must be packed. Marktmorgen cannot tell you what the rules are or whether you meet them.";

type Shipped = {
  id: string;
  label: string;
  hint: string;
  name: string;
  product: string;
  /** Two letters for the blocks' ids, so none repeats on its page. */
  key: string;
  title: string;
  slug: string;
  headline: string;
  sub: string;
  box: { heading: string; items: string[] };
  details: { heading: string; body: string }[];
  before?: string[];
};

function shipped(c: Shipped): FunnelStarter {
  const id = (n: number) => `${c.key}${String(n).padStart(2, "0")}`;
  return {
    id: c.id,
    label: c.label,
    hint: c.hint,
    before: [...(c.before ?? []), SHIP_FIRST],
    bundle: {
      format: BUNDLE_FORMAT, schema: BUNDLE_SCHEMA, name: c.name,
      products: [{ ref: "x1", label: c.product, wants: "paid" }],
      forms: [],
      steps: [{ kind: "page", ref: "p1" }, { kind: "product", ref: "x1" }, { kind: "page", ref: "p2" }],
      pages: [
        {
          ref: "p1", title: c.title, slug: c.slug, target: "x1", style: "cards",
          blocks: [
            { id: id(1), kind: "hero", headline: c.headline, sub: c.sub, media: "none", video: null, button: true },
            { id: id(2), kind: "benefits", heading: c.box.heading, items: c.box.items },
            ...c.details.map((d, i) => ({ id: id(3 + i), kind: "text" as const, heading: d.heading, body: d.body })),
            { id: id(3 + c.details.length), kind: "faq", heading: "Before you order", items: [
              { q: "Where does it ship, and what does shipping cost?", a: "[Say where you ship and what shipping costs, as your shipping settings say. The product's page and the checkout show both from there.]" },
              { q: "When does it ship?", a: "[Say when you ship it, in the same words as the note in your shipping settings.]" },
              { q: "Can I return or exchange it?", a: "[Say how returns and exchanges work, as your refund policy says.]" },
            ] },
            { id: id(4 + c.details.length), kind: "cta", label: "See the product and price", note: "" },
          ],
        },
        nextSteps({ title: "Your order", detail: "[Tell the buyer when you will send it and how they will hear from you.]" }),
      ],
    },
  };
}

FUNNEL_STARTERS.push(
  shipped({
    id: "printed-book", label: "Sell a printed book", name: "Printed book", key: "pb",
    hint: "Show what the book covers and its format, and how shipping and returns work, then lead to the book you ship.",
    product: "The book you ship", title: "Your book", slug: "your-book",
    headline: "[Your book's title]: [what it is about, in a few words]",
    sub: "[Say who it is for and what they will find in it.]",
    box: { heading: "What is inside", items: ["[The first part of the book]", "[The next part of the book]"] },
    details: [{ heading: "Format", body: "[Give its binding, its size, how many pages it has and the language it is written in.]" }],
  }),
  shipped({
    id: "branded-apparel", label: "Sell clothing with your brand", name: "Clothing", key: "ba",
    hint: "Show the garment, its sizes, fabric and care, and how shipping and returns work, then lead to the clothing you ship.",
    product: "The clothing you ship", title: "Your clothing", slug: "your-clothing",
    headline: "[Your garment]: [what it is, in a few words]",
    sub: "[Say what it is made of and what is printed or sewn on it.]",
    box: { heading: "What you get", items: ["[The garment, its fabric and its colors]", "[Anything printed or sewn on it]"] },
    details: [{ heading: "Sizes and care", body: "[Give each size's measurements, how it fits and how to wash it. If you sell sizes as price options, name them the same way here.]" }],
  }),
  shipped({
    id: "course-kit", label: "A kit to go with your course", name: "Course kit", key: "ck",
    hint: "Show what comes in the kit and how it goes with your course, and how shipping and returns work, then lead to the kit you ship.",
    product: "The kit you ship", title: "Your kit", slug: "your-kit",
    headline: "[Your kit]: [what is in it, in a few words]",
    sub: "[Say which course it goes with and who it is for.]",
    box: { heading: "What comes in the kit", items: ["[The first thing in the kit]", "[The next thing in the kit]"] },
    details: [
      { heading: "How it goes with the course", body: "[Say which lessons use it and what to do with it. Say that the kit does not include the course, which is bought on its own, and where to get it.]" },
      { heading: "Size and materials", body: "[Give its measurements, what it is made of and how to look after it.]" },
    ],
  }),
  shipped({
    id: "homemade-food", label: "Sell food you make", name: "Food you make", key: "hf",
    hint: "Show what it is, its ingredients and allergens and how to keep it, and how shipping and returns work, then lead to the food you ship.",
    product: "The food you ship", title: "Your food", slug: "your-food",
    headline: "[Your food]: [what it is, in a few words]",
    sub: "[Say how you make it and what comes in each package.]",
    box: { heading: "What comes in the package", items: ["[What is in each package, and how much]", "[Anything else that comes with it]"] },
    details: [
      { heading: "Ingredients and allergens", body: "[List every ingredient and every allergen, as the label on the package says. Check what a label must say under the rules where you make it and where you ship it.]" },
      { heading: "How to keep it", body: "[Say how to store it once it arrives and how long it keeps, as the label says.]" },
    ],
    before: [FOOD_RULES],
  }),
);

export function funnelStarter(id: unknown): FunnelStarter | null {
  return FUNNEL_STARTERS.find((starter) => starter.id === id) ?? null;
}

/** A starter's outline, with what to do first ahead of the parts to fill in, as its preview says them. */
export function starterOutline(starter: FunnelStarter): BundleOutline {
  const outline = outlineOf(starter.bundle);
  return { ...outline, fill: [...(starter.before ?? []), ...outline.fill] };
}

/** Whether a starter is for something the creator ships: what it says first ends with turning shipping on. */
export function forShipping(starter: FunnelStarter): boolean {
  return starter.before?.at(-1) === SHIP_FIRST;
}

/** What to do first, as lines of the list shown once the starter is made. */
export function starterBeforeLines(starter: FunnelStarter): PlanLine[] {
  return (starter.before ?? []).map((text) => ({ level: "fix", text }));
}
