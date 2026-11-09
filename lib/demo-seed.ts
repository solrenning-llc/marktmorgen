/**
 * Making the demo store, the way a creator makes theirs.
 *
 * The demo store is a store (lib/house-store.ts). Nobody can sign in to it,
 * so it is put together here instead of in the studio — and with nothing but
 * the functions the studio's own routes call: the handle is claimed, the
 * product is added, its price options are added, its files are put in the
 * store's own folder and attached, its picture and the store's photo are
 * kept where every store's are. Not one record is written by hand. Whatever
 * a creator's store is after those calls, this one is too, and a change to
 * any of them changes the demo with it.
 *
 * It runs as often as it is asked and does only what is missing:
 *
 *   - Every step first looks at the store as it is, and writes only when
 *     what is there differs from what is written below. Asked twice, the
 *     second time writes nothing.
 *   - When everything is in place the whole answer is one read: a mark kept
 *     beside the store, carrying a fingerprint of this file's contents. A
 *     new deployment that changes anything below — a price, a sentence, the
 *     file a buyer gets — has another fingerprint, and the store is brought
 *     in line the next time anybody asks.
 *   - A step that could not be finished (the two photographs are fetched
 *     from where they are published, and a fetch can fail) is named in what
 *     comes back and tried again later, not on every request.
 *
 * Asked by the address everybody already has for the demo, /demo, which then
 * sends the visitor to the store itself, and once a day by the scheduled job,
 * so the store is put right even on a day nobody opens it.
 *
 *   nl:house:seed        the mark: fingerprint, what is still missing, when
 *   nl:house:seed:lock   held while it runs, so two requests never both do
 *
 * A run ends before its lock does: the work runs inside a cutoff (lib/fetch-timeout.ts, withCutoff) that leaves
 * the rest of the lock for writing the mark and letting the lock go, and /demo may run no longer than the lock
 * (its maxDuration). A run that is cut stops between two steps, says "run:cutoff" in its mark, and is never
 * written down as finished; its mark keeps what it did finish (the store, its photo, the pictures), never a step
 * left in the middle, and the next run after the wait below does only what is still missing.
 */
import { createHash } from "node:crypto";
import { readNote } from "@/lib/thanks-note";
import { readThanksNote, writeThanksNote } from "@/lib/thanks-note-store";
import { del as blobDel, put as blobPut } from "@/lib/blob";
import { imageSize } from "@/lib/image-size";
import { readListings, productIds } from "@/lib/catalog";
import { isDemoCheckoutConfigured } from "@/lib/demo-store";
import { DEMO_CONNECTED_ACCOUNT } from "@/lib/demo-account";
import { type DemoFileName, getDemoFile } from "@/lib/demo-file";
import { rememberFolderOwner } from "@/lib/delivery";
import { REDIS_TIMEOUT_MS, timeLeft, timed, withCutoff } from "@/lib/fetch-timeout";
import { configuredDemoStudioAdmin, HOUSE_HANDLE, HOUSE_OWNER } from "@/lib/house-store";
import { readAbout, writeAbout } from "@/lib/product-about";
import { type ProductFile, fileFolder } from "@/lib/product-file";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES, SMALL_LONG_SIDE, type ProductImage, imagePath, imagePaths } from "@/lib/product-image";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { type CallSetup, type Range } from "@/lib/call-setup";
import { putMember, readTeam } from "@/lib/team";
import { SITE_URL } from "@/lib/site-url";
import {
  type Listing,
  type Store,
  addOption,
  addProduct,
  addStoreLink,
  claimHandle,
  editOption,
  editProduct,
  editStoreLink,
  imageFolder,
  setPhotoId,
  setProductAbout,
  setProductCall,
  setProductDisplay,
  setProductFile,
  setAnswers,
  setCartDeal,
  setProductNote,
  setProductExtras,
  setFaq,
  setTips,
  setProductImage,
  setProductPage,
  setPostCount,
  setStripeAccount,
  setSubscription,
  storeFolder,
  storeForEmail,
  updateDetails,
  updateLook,
} from "@/lib/store";
import { canSellProduct } from "@/lib/store-checkout";
import { parsePage } from "@/lib/sales-page";
import { readPage, writePage } from "@/lib/sales-page-store";
import { cleanPost, readPost, savePost } from "@/lib/store-blog";
import { type StoreLook } from "@/lib/store-look";
import { MAX_PHOTO_BYTES, deletePhoto, sniffPhotoType, writePhoto } from "@/lib/store-photo";

// ---- What the demo store is --------------------------------------------------

/** Where the two photographs are published. Fetched once, then kept as a store's own. */
const PHOTOS = "https://images.unsplash.com/";
/** How long one of them is waited for. */
const PHOTO_TIMEOUT_MS = 15_000;

/**
 * The fictional creator's store. Jenny is invented, and the store says so in
 * the one sentence every visitor reads: its own description.
 */
export const DEMO_STORE = {
  name: "Harbor Kitchen",
  /**
   * The plan the demo is on: Studio, so a visitor sees what AI does in a
   * store (visitor answers, drafting in the studio), which Store does not
   * include. It is ours to give, and pays nothing, so what it uses is a
   * company cost held by Studio's own automatic ceilings
   * (lib/ai-spend-policy.ts, lib/traffic-rules.ts); it writes to nobody
   * (lib/house-store.ts). Here, not in the step, so a change to it changes
   * the seed's fingerprint and is brought in line on the next deployment.
   */
  tier: "pro",
  bio: "Simple family meals by Jenny, a fictional cook. This is Marktmorgen's demo store: you pay with Stripe's test card, and the file you get is real.",
  look: { theme: "sand", accent: "#e5533d", badge: true, sold: false, font: "modern", backdrop: "glow" } satisfies StoreLook,
  photo: {
    id: "photo-1543871595-e11129e271cc",
    query: "fm=webp&fit=crop&crop=faces&w=480&h=480&q=75",
  },
  /**
   * The store's own questions and answers (lib/store-faq.ts), each true of
   * this demo: what is charged, what is handed over, who Jenny is.
   */
  faq: [
    { q: "Is anything charged in this store?", a: "No. This is Marktmorgen's demo store: its checkout runs in Stripe's test mode, and the test card 4242 4242 4242 4242 moves no real money." },
    { q: "What do I get when I buy?", a: "A real PDF, on the thank-you page right after paying: the meal planner (one week or five), the weekend batch cooking plan, or the grocery list pack." },
    { q: "Who is Jenny?", a: "A fictional cook. The store shows what a creator's store on Marktmorgen looks like and does, from the first visit to the download." },
    { q: "Can I make a store like this one?", a: "Yes. Everything on this page — the products, their pages, the links, these questions — is made in the Marktmorgen studio, without code." },
  ],
  /**
   * "Support my work" (lib/store-tips.ts), switched on so a visitor can try
   * it, and saying in its own line that nothing real is given here.
   */
  tips: {
    on: true,
    heading: "",
    line: "Jenny is fictional, so this one is a try-out: it runs in Stripe's test mode with the test card, and no real money moves.",
    amounts: [] as number[],
  },
  /**
   * "Buy more, save more" (lib/cart-rules.ts), switched on so a visitor sees
   * what a buyer sees: the offer under every Add to cart, the cart counting
   * down to it, and the test-mode checkout charging that much less.
   */
  cartDeal: { on: true, min: 2, percent: 10 },
  /** In the spotlight (lib/store-link.ts), as a creator's one most important link would be. */
  link: { title: "Open a store like this one", url: `${SITE_URL}/`, spotlight: true },
  /**
   * Visitors' questions about the product are answered from its page
   * (lib/answers.ts), so anybody looking at the demo can try the box a
   * creator would switch on. What it is told beyond the page is only this.
   */
  answers: {
    on: true,
    facts:
      "This is a demo store made by Marktmorgen. Jenny is a fictional cook. The checkout runs in Stripe's test mode: no real money moves and no real card is charged. Pay with the test card 4242 4242 4242 4242, any future date and any CVC. The file you get is a real PDF. Because nothing is charged, there is nothing to refund.",
  },
} as const;

/** One product, with two prices, each handing over its own file. */
export const DEMO_PRODUCT = {
  title: "Weekly Meal Planner",
  summary: "Simple family meal plans with breakfasts, lunches, dinners and a grocery list for each week.",
  price: "27",
  about: `A printable plan for the week's meals, with the grocery list that goes with it.

What is inside:
- Breakfast, lunch and dinner for every day of the week
- One grocery list for the whole week
- One page for each week, ready to print

Choose one week, or five weeks at a lower price per week. Each is a PDF you download the moment you pay.`,
  image: {
    id: "photo-1535473895227-bdecb20fb157",
    query: "fm=webp&fit=crop&w=1200&h=675&q=70",
    /** The same photograph at the width of the smaller copy made for phones (SMALL_LONG_SIDE). */
    small: `fm=webp&fit=crop&w=${SMALL_LONG_SIDE}&h=450&q=70`,
    alt: "A table seen from above, covered with prepared dishes and vegetables",
  },
  /**
   * Jenny's note after paying (lib/thanks-note.ts), so a visitor who tries
   * the test checkout sees what a buyer of a creator's store is told: what to
   * do first, and one button. No video: there is no video of Jenny to show.
   */
  note: {
    heading: "",
    body: "Thank you for trying the demo. Start with week one: print the plan and the grocery list, and cook the first dinner tonight.\n\nEverything on this page, this note included, is made in the Marktmorgen studio without code.",
    video: "",
    label: "Open a store like this one",
    url: `${SITE_URL}/`,
  },
  options: [
    { label: "1 week", price: "27", file: "weekly-meal-planner.pdf" },
    { label: "5 weeks", price: "39", file: "meal-planner-5-weeks.pdf" },
  ] satisfies { label: string; price: string; file: DemoFileName }[],
  /**
   * A payment plan over both prices (lib/product-extras.ts), so a visitor
   * sees each price with its own payments, as a buyer of a creator's store
   * would: 3 monthly payments of $9 for one week, of $13 for five. In Stripe's
   * test mode like the rest of the demo, and it stops by itself after the third.
   */
  plan: { payments: 3, interval: "month", each: { "1 week": 900, "5 weeks": 1300 } },
} as const;

/**
 * Two more products (added 9 October 2026), so the demo shows a store with
 * several things to choose between: the cards side by side, and the store
 * page's "Not sure which one is for you?" (lib/store-guide.ts), which a store
 * shows from three products. Each hands over a real PDF of its own, made like
 * the planner's and saying on every page that it is a demo.
 */
export const DEMO_EXTRAS = [
  {
    title: "Weekend Batch Cooking Plan",
    summary: "Two hours on the weekend for four easier weeknight dinners: what to cook, in what order, and what to make of it each night.",
    price: "12",
    file: "weekend-batch-cooking.pdf",
    about: `One page for the weekend: what to cook once, the order that saves the most time, and what each weeknight dinner is made of.

What is inside:
- Four things to cook once: a grain, a tray of vegetables, a pot of soup and a batch of beans or lentils
- Monday to Thursday, each dinner made from them
- The order to cook them in, so the pots look after themselves

A PDF you download the moment you pay.`,
    image: {
      id: "photo-1466637574441-749b8f19452f",
      query: "fm=webp&fit=crop&w=1200&h=675&q=70",
      small: `fm=webp&fit=crop&w=${SMALL_LONG_SIDE}&h=450&q=70`,
      alt: "Vegetables, eggs and a knife on a wooden cutting board",
    },
  },
  {
    title: "Grocery List Pack",
    summary: "A printable grocery list in the order of the store, and a pantry checklist to fill in before you write it.",
    price: "5",
    file: "grocery-list-pack.pdf",
    about: `Two printable pages for the weekly shop.

What is inside:
- A grocery list grouped by aisle: produce, dairy and eggs, meat and fish, bakery, dry goods, frozen and household
- A pantry checklist of the basics, to check before you write the list

A PDF you download the moment you pay. Print a copy for each week.`,
    image: {
      id: "photo-1542838132-92c53300491e",
      query: "fm=webp&fit=crop&w=1200&h=675&q=70",
      small: `fm=webp&fit=crop&w=${SMALL_LONG_SIDE}&h=450&q=70`,
      alt: "Shelves of fresh vegetables and fruit in a grocery store",
    },
  },
] as const satisfies readonly {
  title: string;
  summary: string;
  price: string;
  file: DemoFileName;
  about: string;
  image: { id: string; query: string; small: string; alt: string };
}[];

type DemoExtra = (typeof DEMO_EXTRAS)[number];
type PictureSpec = { id: string; query: string; small: string; alt: string };

/**
 * The call the demo store sells (added 11 October 2026): a booked time,
 * delivered as a Zoom meeting on the store's own connected account
 * (lib/meet-links.ts), so the demo shows the whole of what a creator sells —
 * files and time — and not files alone.
 *
 * It is a product like any other: added, priced and set up through the same
 * functions the studio calls, bought through the same checkout, in Stripe's
 * test mode like everything else here. Whoever books one picks a time, pays
 * with the test card, and is given the meeting's link on the thank-you page,
 * with the same page's link to move it to another time.
 *
 * The hours are wide on purpose — every weekday, morning to evening, New York
 * time — because somebody trying the demo should find a time without hunting
 * for one, in their own part of the world.
 */
export const DEMO_CALL = {
  title: "Meal-planning call",
  summary: "Thirty minutes to plan your week's meals around what is already in your kitchen.",
  price: "20",
  about: `Half an hour, by video, to turn a week of "what do we eat tonight?" into a plan and one grocery list.

What happens on the call:
- You say who you cook for, what you have, and the nights that are always hard
- We write the week together: breakfasts, lunches, dinners
- You leave with the plan and the list, and know what to cook first

Pick a time and pay with the test card. You get the meeting link the moment you book, on the page and in your calendar file.`,
  image: {
    id: "photo-1543269865-cbf427effbad",
    query: "fm=webp&fit=crop&w=1200&h=675&q=70",
    small: `fm=webp&fit=crop&w=${SMALL_LONG_SIDE}&h=450&q=70`,
    alt: "Four people around a table with laptops, talking and laughing",
  },
  /**
   * Weekly hours, Monday to Friday, 9:00 to 19:00 in New York — written as
   * minutes from midnight, which is what a stretch is (lib/call-setup.ts).
   * One buyer per time, an hour's notice, thirty days ahead, and a Zoom
   * meeting for each booking.
   */
  setup: {
    kind: "weekly",
    minutes: 30,
    tz: "America/New_York",
    weekly: [[], [[540, 1140]], [[540, 1140]], [[540, 1140]], [[540, 1140]], [[540, 1140]], []],
    noticeHours: 1,
    horizonDays: 30,
    bufferMinutes: 0,
    room: null,
    video: false,
    meet: "zoom",
    seats: 1,
    sessions: [],
  },
} as const;

/**
 * The product's own sales page, built from the blocks a creator adds in the
 * studio (added 9 October 2026), so whoever opens the demo sees a page made
 * with Marktmorgen rather than a plain description. Every sentence is true
 * of this demo: the product and its files are real, Jenny is not, and the
 * questions say so. No review, quote or number is written here; the reviews
 * a page shows are only ever buyers'.
 */
export const DEMO_PAGE = {
  style: "bands",
  seoTitle: "Weekly Meal Planner — Harbor Kitchen, a Marktmorgen demo",
  seoDescription: "A printable week of family meals with its grocery list. The demo store of Marktmorgen: pay with Stripe's test card, get the real PDF.",
  blocks: [
    { id: "demohero", kind: "hero", headline: "Dinner, decided before the week begins", sub: "A printable plan for breakfast, lunch and dinner, with the grocery list that goes with it. One week to try, or five.", media: "picture", video: null, button: true },
    { id: "demogets", kind: "benefits", heading: "What you get", items: ["Breakfast, lunch and dinner for every day of the week", "One grocery list for the whole week", "One page for each week, ready to print", "A PDF you download the moment you pay"] },
    {
      id: "demosteps",
      kind: "steps",
      heading: "How it works",
      items: [
        { title: "Choose one week or five", detail: "Five weeks cost less per week." },
        { title: "Pay with the test card", detail: "This is a demo: 4242 4242 4242 4242, any future date and any CVC. Nothing is charged." },
        { title: "Download your PDF", detail: "Right after paying, on the thank-you page, and by email." },
        { title: "Print it and shop once", detail: "Put the week on the fridge and take the list to the store." },
      ],
    },
    {
      id: "demofit",
      kind: "fit",
      heading: "Is it for you?",
      yesLabel: "",
      noLabel: "",
      yes: ["You cook for a family and want the week decided", "You would rather shop once a week than every day"],
      no: ["You want recipes with step-by-step photos or videos", "You follow a diet a professional set for you"],
    },
    { id: "democta", kind: "cta", label: "Get the planner", note: "Test mode: nothing is charged." },
    {
      id: "demofaq",
      kind: "faq",
      heading: "Questions",
      items: [
        { q: "Is anything charged?", a: "No. This is Marktmorgen's demo store: its checkout runs in Stripe's test mode, and the test card moves no real money." },
        { q: "What do I get?", a: "A real PDF: one week of plans, or five weeks, depending on the option you choose." },
        { q: "Who is Jenny?", a: "A fictional cook. The store shows what a creator's store on Marktmorgen looks like." },
        { q: "Can I build a page like this one?", a: "Yes. Every part of this page is a block a creator adds, moves and fills in from the studio, or has drafted with AI." },
      ],
    },
    { id: "demoend", kind: "cta", label: "Get the planner", note: "" },
  ],
} as const;

/**
 * One post on the demo's blog (lib/store-blog.ts), so whoever opens the demo
 * sees what a creator's blog looks like. Plain advice, true for anyone, with
 * no claim about results, written by the same fictional cook; it ends on the
 * product, as a creator's post may.
 */
export const DEMO_POST = {
  id: "0000000d01",
  title: "How to plan a week of family dinners in 20 minutes",
  body: `Planning the week's dinners once, on one day, is what saves the other six. Here is a way to do it in about twenty minutes.

## Start from what you already have
Open the fridge and the cupboard before you open a cookbook.
- Note what needs using up first: greens, opened jars, half a bag of rice
- Plan the first two dinners around those

## Give each night a rule
A rule makes the choice for you on a busy evening.
- Monday: something in one pan
- Tuesday: soup or a big salad
- Wednesday: pasta
- Thursday: leftovers night
- Friday: something everyone builds at the table

## Write one grocery list, in the order of the store
Group the list by aisle: produce, dairy, dry goods, frozen. One trip, no backtracking, and nothing forgotten.

## Cook twice, eat three times
Make a double batch of one dinner early in the week and keep the second half for the leftovers night.

That is the whole method. The planner below puts it on one printable page per week, with the grocery list beside it.`,
  product: true,
} as const;

// ---- The mark ----------------------------------------------------------------

const MARK = "nl:house:seed";
const LOCK = "nl:house:seed:lock";
const LOCK_SECONDS = 120;
/**
 * How long the work may run, counted from just before the lock is taken: the twenty seconds left of the lock are
 * for writing the mark and letting the lock go (one Redis request each, at most REDIS_TIMEOUT_MS), with room.
 */
const BUILD_MS = (LOCK_SECONDS - 20) * 1000;
/** Kept, inside a cutoff of the caller's own (the daily job's), for writing the mark and letting the lock go. */
const WRITE_ROOM_MS = 2 * REDIS_TIMEOUT_MS;
/** Below this, there is no time to ask anything more (lib/fetch-timeout.ts, timed). */
const NO_TIME_MS = 50;
const CUTOFF = "cutoff";

/** What a run that reached its cutoff stops with, between two steps. */
class CutOff extends Error {
  constructor() {
    super(CUTOFF);
  }
}

/** Stops the run here when its cutoff has come: nothing more is asked, and nothing after this is written. */
function inTime(): void {
  if (timeLeft() < NO_TIME_MS) throw new CutOff();
}

/** The stand-ins and the real file store alike, each asked only while there is time. */
function bounded(deps: SeedDeps): SeedDeps {
  return {
    putFile: async (pathname, bytes, contentType) => {
      inTime();
      await deps.putFile(pathname, bytes, contentType);
    },
    removeFile: async (pathname) => {
      inTime();
      await deps.removeFile(pathname);
    },
    fetchBytes: async (url) => {
      inTime();
      return deps.fetchBytes(url);
    },
  };
}
/** How long a step that failed is left before it is tried again. */
export const RETRY_SECONDS = 10 * 60;

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Everything above, and the files themselves, as one short word. */
/**
 * Who may open the demo store's studio (lib/house-store.ts): the address
 * supplied by DEMO_STUDIO_ADMIN in the server environment. Anything that
 * is not an address puts nobody on the team.
 */
function demoStudioAdmin(): string {
  return configuredDemoStudioAdmin();
}

export function seedFingerprint(): string {
  const files = [...DEMO_PRODUCT.options.map((option) => option.file), ...DEMO_EXTRAS.map((extra) => extra.file)].map((file) => sha(getDemoFile(file)));
  return sha(JSON.stringify([HOUSE_HANDLE, DEMO_STORE, DEMO_PRODUCT, DEMO_EXTRAS, DEMO_CALL, DEMO_PAGE, DEMO_POST, files, DEMO_CONNECTED_ACCOUNT, demoStudioAdmin()])).slice(0, 24);
}

type Mark = {
  /** The fingerprint the store was last brought in line with. */
  v: string;
  /** What could not be finished then; empty when everything is in place. */
  pending: string[];
  /** When, in seconds. */
  at: number;
  /** Whether the store was there at all. */
  store: boolean;
  /** The photographs kept on the store, by where each came from. */
  photo: string;
  image: string;
  /** The extra products' pictures, by product title, by where each came from. */
  images: Record<string, string>;
};

function parseMark(raw: unknown): Mark | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Mark>;
    if (typeof value.v !== "string" || typeof value.at !== "number") return null;
    return {
      v: value.v,
      pending: Array.isArray(value.pending) ? value.pending.filter((p): p is string => typeof p === "string").slice(0, 20) : [],
      at: value.at,
      store: value.store === true,
      photo: typeof value.photo === "string" ? value.photo : "",
      image: typeof value.image === "string" ? value.image : "",
      images:
        value.images && typeof value.images === "object"
          ? Object.fromEntries(Object.entries(value.images).filter((e): e is [string, string] => typeof e[1] === "string"))
          : {},
    };
  } catch {
    return null;
  }
}

export type SeedResult = {
  /** Whether the demo store is there to be opened. */
  ok: boolean;
  /** What is still missing, in a word each. Empty when it is all in place. */
  pending: string[];
  /** Whether this call did any work, or only read the mark. */
  ran: boolean;
};

// ---- What it needs from outside ----------------------------------------------

/**
 * The two things that are not Redis: the file store, and the place the
 * photographs are fetched from. Handed in so a test can stand in for both.
 */
export type SeedDeps = {
  putFile: (pathname: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  removeFile: (pathname: string) => Promise<void>;
  fetchBytes: (url: string) => Promise<Uint8Array>;
};

const REAL: SeedDeps = {
  putFile: async (pathname, bytes, contentType) => {
    await blobPut(pathname, Buffer.from(bytes), { access: "private", contentType, addRandomSuffix: false, allowOverwrite: true });
  },
  removeFile: async (pathname) => {
    await blobDel(pathname);
  },
  fetchBytes: (url) =>
    timed(PHOTO_TIMEOUT_MS, async (signal) => {
      const response = await fetch(url, { signal, cache: "no-store" });
      if (!response.ok) throw new Error(`fetch_${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }),
};

export { imageSize } from "@/lib/image-size";

// ---- The steps ---------------------------------------------------------------

const REF = HOUSE_OWNER;

const refused = (step: string, reason: string) => `${step}:${reason}`;
const why = (error: unknown) => (error instanceof Error ? error.message : "failed").replace(/[^a-z0-9_]+/gi, "_").slice(0, 40);

/** The store itself: its address, its name and words, its look, its account, its plan. */
async function ensureStore(pending: string[]): Promise<Store | null> {
  let store = await storeForEmail(REF);
  if (!store) {
    const claimed = await claimHandle(REF, HOUSE_HANDLE, DEMO_STORE.name, DEMO_STORE.bio);
    if (!claimed.ok) {
      pending.push(refused("handle", claimed.reason));
      return null;
    }
    store = claimed.store;
  }
  if (store.name !== DEMO_STORE.name || store.bio !== DEMO_STORE.bio) {
    const done = await updateDetails(REF, DEMO_STORE.name, DEMO_STORE.bio);
    if (done.ok) store = done.store;
    else pending.push(refused("details", done.reason));
  }
  const look = store.look;
  if (look.theme !== DEMO_STORE.look.theme || look.accent !== DEMO_STORE.look.accent || look.badge !== DEMO_STORE.look.badge || look.backdrop !== DEMO_STORE.look.backdrop) {
    const done = await updateLook(REF, { ...DEMO_STORE.look });
    if (done.ok) store = done.store;
    else pending.push(refused("look", done.reason));
  }
  // The fictional creator's own account, in Stripe's test mode, charged
  // directly as a creator's is. It can take a payment for as long as the
  // demo's key is there to ask with (lib/demo-account.ts).
  const charges = isDemoCheckoutConfigured();
  if (store.stripeAccountId !== DEMO_CONNECTED_ACCOUNT || store.stripeChargesEnabled !== charges) {
    const done = await setStripeAccount(REF, DEMO_CONNECTED_ACCOUNT, charges);
    if (done.ok) store = done.store;
    else pending.push(refused("account", done.reason));
  }
  if (!charges) pending.push(refused("account", "no_key"));
  // The demo's plan (DEMO_STORE.tier), which is ours to give to our own
  // store. No subscription is written down for it, because there is none:
  // the daily check of subscriptions and the studio both ask Stripe only
  // about a store that names one (lib/billing-sync.ts), so neither ever
  // takes this back.
  if (!store.subscriptionActive || store.tier !== DEMO_STORE.tier || store.subscriptionId !== null) {
    const done = await setSubscription(REF, { active: true, tier: DEMO_STORE.tier, cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0, shared: false });
    if (done) store = done;
    else pending.push(refused("plan", "refused"));
  }
  if (JSON.stringify(store.faq) !== JSON.stringify(DEMO_STORE.faq)) {
    const done = await setFaq(REF, DEMO_STORE.faq);
    if (done) store = done;
    else pending.push(refused("faq", "refused"));
  }
  if (JSON.stringify(store.tips) !== JSON.stringify(DEMO_STORE.tips)) {
    const done = await setTips(REF, { ...DEMO_STORE.tips, amounts: [...DEMO_STORE.tips.amounts] });
    if (done) store = done;
    else pending.push(refused("tips", "refused"));
  }
  if (store.answers.on !== DEMO_STORE.answers.on || store.answers.facts !== DEMO_STORE.answers.facts) {
    const done = await setAnswers(REF, { ...DEMO_STORE.answers });
    if (done) store = done;
    else pending.push(refused("answers", "refused"));
  }
  if (JSON.stringify(store.cartDeal) !== JSON.stringify(DEMO_STORE.cartDeal)) {
    const done = await setCartDeal(REF, { ...DEMO_STORE.cartDeal });
    if (done) store = done;
    else pending.push(refused("cart_deal", "refused"));
  }
  const extras = { spotlight: DEMO_STORE.link.spotlight };
  if (!store.links.some((link) => link.url === DEMO_STORE.link.url && link.title === DEMO_STORE.link.title && Boolean(link.spotlight) === extras.spotlight)) {
    const same = store.links.find((link) => link.url === DEMO_STORE.link.url);
    const done = same
      ? await editStoreLink(REF, same.id, DEMO_STORE.link.title, DEMO_STORE.link.url, extras)
      : await addStoreLink(REF, DEMO_STORE.link.title, DEMO_STORE.link.url, extras);
    if (done.ok) store = done.store;
    else pending.push(refused("link", done.reason));
  }
  return store;
}

/** The product and its two prices. Found by what they are called, so asking again adds nothing. */
async function ensureProduct(store: Store, pending: string[]): Promise<{ store: Store; product: Listing } | null> {
  const find = async (from: Store) => (await readListings(from, productIds(from))).find((p) => p.title === DEMO_PRODUCT.title) ?? null;
  let product = await find(store);
  if (!product) {
    const made = await addProduct(REF, DEMO_PRODUCT.title, DEMO_PRODUCT.summary, DEMO_PRODUCT.price);
    if (!made.ok) {
      pending.push(refused("product", made.reason));
      return null;
    }
    store = made.store;
  } else if (product.summary !== DEMO_PRODUCT.summary || product.priceCents !== Number(DEMO_PRODUCT.price) * 100) {
    const done = await editProduct(REF, product.id, DEMO_PRODUCT.title, DEMO_PRODUCT.summary, DEMO_PRODUCT.price);
    if (done.ok) store = done.store;
    else pending.push(refused("product", done.reason));
  }
  product = await find(store);
  if (!product) return null;

  for (const want of DEMO_PRODUCT.options) {
    const have = product.options.find((option) => option.label === want.label);
    const cents = Number(want.price) * 100;
    if (have && have.priceCents === cents) continue;
    const done = have ? await editOption(REF, have.id, want.label, want.price) : await addOption(REF, product.id, want.label, want.price);
    if (done.ok) store = done.store;
    else pending.push(refused(`option_${want.file}`, done.reason));
  }
  product = await find(store);
  return product ? { store, product } : null;
}

/** Each price's own file, in the store's own folder, attached the way an upload is. */
async function ensureFiles(store: Store, product: Listing, deps: SeedDeps, pending: string[]): Promise<Store> {
  const folder = await storeFolder(REF);
  // Whose folder it is, as an upload from the studio notes it (lib/delivery.ts).
  await rememberFolderOwner(folder, REF);
  for (const want of DEMO_PRODUCT.options) {
    const option = product.options.find((o) => o.label === want.label);
    if (!option) continue;
    const bytes = getDemoFile(want.file);
    // Named by what is in it: another file is another path, and the same
    // file put twice is the same path.
    const pathname = `${fileFolder(folder, option.id)}${sha(bytes).slice(0, 20)}.pdf`;
    if (option.file?.pathname === pathname && option.file.name === want.file) continue;
    try {
      await deps.putFile(pathname, bytes, "application/pdf");
      const file: ProductFile = { pathname, name: want.file, bytes: bytes.byteLength, contentType: "application/pdf", addedAt: new Date().toISOString() };
      const done = await setProductFile(REF, option.id, file);
      if (!done.ok) {
        pending.push(refused(`file_${want.file}`, done.reason));
        continue;
      }
      store = done.store;
      // After the record that replaced it is written, as the studio does.
      if (done.removed && done.removed.pathname !== pathname) await deps.removeFile(done.removed.pathname).catch(() => {});
    } catch (error) {
      pending.push(refused(`file_${want.file}`, why(error)));
    }
  }
  return store;
}

/**
 * The product's picture and its smaller copy for phones, kept in the store's
 * own picture folder: the two files a creator's browser makes and sends when
 * a picture is added in the studio (components/product-image-editor.tsx).
 */
async function ensureImage(
  store: Store,
  product: Listing,
  was: string,
  deps: SeedDeps,
  pending: string[],
  want: PictureSpec = DEMO_PRODUCT.image,
  across = true,
): Promise<{ store: Store; source: string }> {
  // Where the two files came from. Another photograph, or another size of
  // this one, is another source, and is fetched again.
  const source = `${want.id}?${want.query}|${want.small}`;
  const have = product.image && was === source ? product.image : null;
  if (have && have.alt === want.alt && (!across || product.display === "preview")) return { store, source };
  try {
    let image: ProductImage | null = have ? { ...have, alt: want.alt } : null;
    if (!image) {
      const folder = await imageFolder(REF);
      const fetched = async (query: string) => {
        const bytes = await deps.fetchBytes(`${PHOTOS}${want.id}?${query}`);
        const type = sniffPhotoType(bytes);
        const size = imageSize(bytes);
        if (!type || !(IMAGE_CONTENT_TYPES as readonly string[]).includes(type) || !size) throw new Error("type");
        if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("too_big");
        const path = imagePath(folder, sha(bytes).slice(0, 32), type);
        await deps.putFile(path, bytes, type);
        return { path, width: size.width, height: size.height, bytes: bytes.byteLength };
      };
      const full = await fetched(want.query);
      const copy = await fetched(want.small);
      if (copy.width >= full.width || copy.path === full.path) throw new Error("small");
      image = { ...full, alt: want.alt, small: { path: copy.path, width: copy.width, bytes: copy.bytes } };
    }
    const attached = image;
    const done = await setProductImage(REF, product.id, attached);
    if (!done.ok) {
      pending.push(refused(across ? "image" : `image_${want.id.slice(-6)}`, done.reason));
      return { store, source: was };
    }
    store = done.store;
    // The picture it replaced, and that picture's own copy, once nothing points at them.
    const kept = new Set(imagePaths(attached));
    for (const gone of imagePaths(done.removed)) {
      if (!kept.has(gone)) await deps.removeFile(gone).catch(() => {});
    }
    // Across the whole card for the planner, the product the demo leads with.
    if (across) {
      const shown = await setProductDisplay(REF, product.id, "preview");
      if (shown.ok) store = shown.store;
    }
    return { store, source };
  } catch (error) {
    pending.push(refused(across ? "image" : `image_${want.id.slice(-6)}`, why(error)));
    return { store, source: was };
  }
}

/** The store's photo, kept where every store's is. */
async function ensurePhoto(store: Store, was: string, deps: SeedDeps, pending: string[]): Promise<{ store: Store; source: string }> {
  const want = DEMO_STORE.photo;
  if (store.photoId && was === want.id) return { store, source: was };
  try {
    const bytes = await deps.fetchBytes(`${PHOTOS}${want.id}?${want.query}`);
    const type = sniffPhotoType(bytes);
    if (!type) throw new Error("type");
    if (bytes.byteLength > MAX_PHOTO_BYTES) throw new Error("too_big");
    const id = await writePhoto(bytes, type);
    const done = await setPhotoId(REF, id);
    if (!done.ok) {
      await deletePhoto(id);
      pending.push(refused("photo", done.reason));
      return { store, source: was };
    }
    await deletePhoto(done.was);
    return { store: done.store, source: want.id };
  } catch (error) {
    pending.push(refused("photo", why(error)));
    return { store, source: was };
  }
}

/** The long description on the product's own page. */
async function ensureAbout(store: Store, product: Listing, pending: string[], text: string = DEMO_PRODUCT.about): Promise<Store> {
  if (!store.statsId) {
    pending.push(refused("about", "no_stats"));
    return store;
  }
  const have = product.about ? await readAbout(store.statsId, product.id) : "";
  if (have === text) return store;
  const marked = await setProductAbout(REF, product.id, true);
  if (!marked.ok || !marked.store.statsId) {
    pending.push(refused("about", marked.ok ? "no_stats" : marked.reason));
    return store;
  }
  await writeAbout(marked.store.statsId, product.id, text, marked.store, true);
  return marked.store;
}

/** Jenny's note after paying, saved the way the studio's note route saves one. */
async function ensureNote(store: Store, product: Listing, pending: string[]): Promise<Store> {
  if (!store.statsId) {
    pending.push(refused("note", "no_stats"));
    return store;
  }
  const want = readNote(DEMO_PRODUCT.note);
  if (typeof want === "string") {
    pending.push(refused("note", want));
    return store;
  }
  const have = product.note ? await readThanksNote(store.statsId, product.id) : null;
  if (have && JSON.stringify(have) === JSON.stringify(want)) return store;
  await writeThanksNote(store.statsId, product.id, want, store);
  const marked = await setProductNote(REF, product.id, true);
  if (!marked.ok) {
    pending.push(refused("note", marked.reason));
    return store;
  }
  return marked.store;
}

/** The payment plan over both prices, saved the way the studio's extras route saves one. */
async function ensurePlan(store: Store, product: Listing, pending: string[]): Promise<Store> {
  const want = DEMO_PRODUCT.plan;
  const options: Record<string, number> = {};
  for (const option of product.options) {
    const cents = want.each[option.label as keyof typeof want.each];
    if (cents) options[option.id] = cents;
  }
  const plan = { payments: want.payments, interval: want.interval, amountCents: Math.min(...Object.values(options)), options };
  if (JSON.stringify(product.plan) === JSON.stringify(plan)) return store;
  const done = await setProductExtras(REF, product.id, { plan });
  if (!done.ok) {
    pending.push(refused("plan", done.reason));
    return store;
  }
  return done.store;
}

/** The product's sales page, saved the way the studio's page route saves one. */
async function ensurePage(store: Store, product: Listing, pending: string[]): Promise<Store> {
  if (!store.statsId) {
    pending.push(refused("page", "no_stats"));
    return store;
  }
  const want = parsePage(DEMO_PAGE);
  const have = product.page ? await readPage(store.statsId, product.id) : null;
  if (have && JSON.stringify(have) === JSON.stringify(want)) return store;
  await writePage(store.statsId, product.id, want, store, true);
  const marked = await setProductPage(REF, product.id, true);
  if (!marked.ok) {
    pending.push(refused("page", marked.reason));
    return store;
  }
  return marked.store;
}

/** The one post on the demo's blog, saved the way the studio's blog route saves one. */
async function ensurePost(store: Store, product: Listing, pending: string[]): Promise<Store> {
  if (!store.statsId) {
    pending.push(refused("post", "no_stats"));
    return store;
  }
  const want = { title: DEMO_POST.title, body: cleanPost({ body: DEMO_POST.body }).body, product: DEMO_POST.product ? product.id : null, draft: false };
  const have = await readPost(store.statsId, DEMO_POST.id);
  if (have && !have.draft && have.title === want.title && have.body === want.body && have.product === want.product && store.posts > 0) return store;
  const saved = await savePost(store.statsId, have ? DEMO_POST.id : null, want, () => DEMO_POST.id, store);
  if (!saved.ok) {
    pending.push(refused("post", saved.reason));
    return store;
  }
  return (await setPostCount(REF, saved.published)) ?? store;
}

/** One of the extra products: added, kept to its words and price, its PDF attached, its picture and its long description. */
async function ensureExtra(store: Store, want: DemoExtra, mark: Mark, deps: SeedDeps, pending: string[]): Promise<Store> {
  const step = want.file.replace(/\.pdf$/, "");
  const find = async (from: Store) => (await readListings(from, productIds(from))).find((p) => p.title === want.title) ?? null;
  let product = await find(store);
  if (!product) {
    const made = await addProduct(REF, want.title, want.summary, want.price);
    if (!made.ok) {
      pending.push(refused(`product_${step}`, made.reason));
      return store;
    }
    store = made.store;
  } else if (product.summary !== want.summary || product.priceCents !== Number(want.price) * 100) {
    const done = await editProduct(REF, product.id, want.title, want.summary, want.price);
    if (done.ok) store = done.store;
    else pending.push(refused(`product_${step}`, done.reason));
  }
  product = await find(store);
  if (!product) return store;

  // Its own PDF, in the store's own folder, attached the way an upload is.
  const folder = await storeFolder(REF);
  await rememberFolderOwner(folder, REF);
  const bytes = getDemoFile(want.file);
  const pathname = `${fileFolder(folder, product.id)}${sha(bytes).slice(0, 20)}.pdf`;
  if (product.file?.pathname !== pathname || product.file.name !== want.file) {
    try {
      await deps.putFile(pathname, bytes, "application/pdf");
      const file: ProductFile = { pathname, name: want.file, bytes: bytes.byteLength, contentType: "application/pdf", addedAt: new Date().toISOString() };
      const done = await setProductFile(REF, product.id, file);
      if (!done.ok) pending.push(refused(`file_${want.file}`, done.reason));
      else {
        store = done.store;
        if (done.removed && done.removed.pathname !== pathname) await deps.removeFile(done.removed.pathname).catch(() => {});
      }
    } catch (error) {
      pending.push(refused(`file_${want.file}`, why(error)));
    }
  }

  const picture = await ensureImage(store, product, mark.images[want.title] ?? "", deps, pending, want.image, false);
  store = picture.store;
  mark.images[want.title] = picture.source;
  return ensureAbout(store, product, pending, want.about);
}

/**
 * The call: added like any product, then given its hours, its length and the
 * service its meetings are made on (setProductCall, the studio's own call).
 * Its picture and its long description are kept the way the others' are.
 */
async function ensureCall(store: Store, mark: Mark, deps: SeedDeps, pending: string[]): Promise<Store> {
  const find = async (from: Store) => (await readListings(from, productIds(from))).find((p) => p.title === DEMO_CALL.title) ?? null;
  let product = await find(store);
  if (!product) {
    const made = await addProduct(REF, DEMO_CALL.title, DEMO_CALL.summary, DEMO_CALL.price);
    if (!made.ok) {
      pending.push(refused("product_call", made.reason));
      return store;
    }
    store = made.store;
  } else if (product.summary !== DEMO_CALL.summary || product.priceCents !== Number(DEMO_CALL.price) * 100) {
    const done = await editProduct(REF, product.id, DEMO_CALL.title, DEMO_CALL.summary, DEMO_CALL.price);
    if (done.ok) store = done.store;
    else pending.push(refused("product_call", done.reason));
  }
  product = await find(store);
  if (!product) return store;

  // The hours themselves. Written only when what is there differs, so asking
  // twice writes nothing; a setup saved by hand would be put back in line.
  const want: CallSetup = {
    kind: DEMO_CALL.setup.kind,
    minutes: DEMO_CALL.setup.minutes,
    tz: DEMO_CALL.setup.tz,
    weekly: DEMO_CALL.setup.weekly.map((day) => day.map(([from, to]) => [from, to] as Range)),
    noticeHours: DEMO_CALL.setup.noticeHours,
    horizonDays: DEMO_CALL.setup.horizonDays,
    bufferMinutes: DEMO_CALL.setup.bufferMinutes,
    room: DEMO_CALL.setup.room,
    video: DEMO_CALL.setup.video,
    meet: DEMO_CALL.setup.meet,
    seats: DEMO_CALL.setup.seats,
    sessions: [],
  };
  if (JSON.stringify(product.call) !== JSON.stringify(want)) {
    const done = await setProductCall(REF, product.id, want);
    if (done.ok) store = done.store;
    else pending.push(refused("call_setup", done.reason));
    product = (await find(store)) ?? product;
  }

  const picture = await ensureImage(store, product, mark.images[DEMO_CALL.title] ?? "", deps, pending, DEMO_CALL.image, false);
  store = picture.store;
  mark.images[DEMO_CALL.title] = picture.source;
  return ensureAbout(store, product, pending, DEMO_CALL.about);
}

/** A run's own mark, before it has done anything: the pictures already in place are carried over from the mark before. */
function startMark(before: Mark | null): Mark {
  return { v: seedFingerprint(), pending: [], at: Math.floor(Date.now() / 1000), store: false, photo: before?.photo ?? "", image: before?.image ?? "", images: { ...(before?.images ?? {}) } };
}

/** Names `step` among what is still missing, once. */
function named(mark: Mark, step: string): void {
  if (!mark.pending.includes(step)) mark.pending.push(step);
}

/**
 * Brings the demo store in line with this file, one step at a time, writing into `mark` as it goes: a step is
 * written down only once it is in place, so a run that stops in the middle of one (cut, or failed) leaves that step
 * as it was in the mark before, and keeps the steps it did finish.
 */
async function build(mark: Mark, deps: SeedDeps): Promise<void> {
  const pending = mark.pending;
  let store = await ensureStore(pending);
  if (!store) return;
  mark.store = true;
  inTime();

  const photo = await ensurePhoto(store, mark.photo, deps, pending);
  store = photo.store;
  mark.photo = photo.source;
  inTime();

  const made = await ensureProduct(store, pending);
  if (!made) {
    if (!pending.some((p) => p.startsWith("product"))) pending.push(refused("product", "missing"));
    return;
  }
  inTime();
  store = await ensureFiles(made.store, made.product, deps, pending);
  inTime();
  const picture = await ensureImage(store, made.product, mark.image, deps, pending);
  store = picture.store;
  mark.image = picture.source;
  inTime();
  store = await ensureAbout(store, made.product, pending);
  inTime();
  store = await ensurePage(store, made.product, pending);
  inTime();
  store = await ensureNote(store, made.product, pending);
  inTime();
  store = await ensurePlan(store, made.product, pending);
  inTime();
  store = await ensurePost(store, made.product, pending);
  for (const extra of DEMO_EXTRAS) {
    inTime();
    store = await ensureExtra(store, extra, mark, deps, pending);
  }
  inTime();
  store = await ensureCall(store, mark, deps, pending);
  inTime();

  // Whoever connects the demo store's Zoom and Google Calendar in its studio
  // (lib/team.ts, putMember), from lib/house-store.ts.
  const admin = demoStudioAdmin();
  if (admin) {
    const done = await putMember(store, admin, "admin").catch(() => false);
    if (!done && !(await readTeam(store.sid)).members.some((m) => m.email === admin)) {
      pending.push(refused("studio_admin", "refused"));
    }
  }

  // The one thing all of it is for: the product can be bought.
  const fresh = await storeForEmail(REF);
  const product = fresh ? (await readListings(fresh, productIds(fresh))).find((p) => p.title === DEMO_PRODUCT.title) : null;
  if (!fresh || !product || !canSellProduct(fresh, product)) {
    if (!pending.length) pending.push(refused("selling", "off"));
  }
}

/**
 * Makes sure the demo store is there and is what this file says. One read
 * when it is; the work, under a lock, when it is not.
 */
export async function ensureDemoStore(deps: SeedDeps = REAL): Promise<SeedResult> {
  if (!isRedisConfigured()) return { ok: false, pending: ["storage"], ran: false };
  const [raw] = await redisPipeline([["GET", MARK]]);
  const mark = parseMark(raw);
  const now = Math.floor(Date.now() / 1000);
  const current = mark !== null && mark.v === seedFingerprint();
  if (current && mark.pending.length === 0) return { ok: true, pending: [], ran: false };
  // Something failed a moment ago: left alone for a while, not tried on every visit.
  if (current && now - mark.at < RETRY_SECONDS) return { ok: mark.store, pending: mark.pending, ran: false };

  // Inside a caller's own cutoff (the daily job's), with no time left to build and write: nothing is taken or written.
  if (timeLeft() - WRITE_ROOM_MS < 1_000) return { ok: mark?.store ?? false, pending: mark?.pending.length ? mark.pending : [refused("run", CUTOFF)], ran: false };

  // One run at a time, on an exact claim (lib/claim-mark.ts, CX-123 rule 24): held by another run is busy; an unknown
  // answer builds nothing this time and is named, and the lock is let go at the end only while it still holds this
  // run's own value, so a run never deletes another run's lock.
  const started = Date.now();
  const lock = claimValue();
  const got = await claimMark(LOCK, LOCK_SECONDS, lock);
  // Somebody else is doing it right now. The store, if there was one, is still there.
  if (got === "taken") return { ok: mark?.store ?? false, pending: mark?.pending ?? ["busy"], ran: false };
  if (got !== "ours") {
    console.error("the demo store's lock answered in an unknown shape; nothing is built this time");
    return { ok: mark?.store ?? false, pending: [refused("lock", "unknown")], ran: false };
  }
  // What this run has done, written down as it goes. A run that is cut, or fails, writes this, not the mark before
  // it: the store and the pictures it put in place are kept, and the next run does only what is still missing.
  const next = startMark(mark);
  try {
    try {
      // The work ends before the lock does, and before a caller's own cutoff, with room to write the mark and let go.
      const end = Math.min(started + BUILD_MS, Date.now() + timeLeft() - WRITE_ROOM_MS);
      await withCutoff(end, async () => {
        try {
          await build(next, bounded(deps));
        } catch (error) {
          // Stopped between two steps at the cutoff, or by a request given up there: what is done stays done.
          if (!(error instanceof CutOff) && timeLeft() >= NO_TIME_MS) throw error;
        }
        // A request given up at the cutoff may have been read by a step as "nothing there": never finished.
        if (timeLeft() < NO_TIME_MS) named(next, refused("run", CUTOFF));
      });
    } catch (error) {
      console.error("making the demo store failed", error);
      // Named, so the next few visits do not each try again; what the run did before it failed is kept.
      named(next, refused("run", why(error)));
    }
    try {
      await redisPipeline([["SET", MARK, JSON.stringify(next)]]);
    } catch (error) {
      console.error("writing down the demo store's mark failed", error);
      named(next, refused("run", why(error)));
    }
    return { ok: next.store, pending: next.pending, ran: true };
  } finally {
    await releaseMark(LOCK, lock);
  }
}
