/**
 * The demo store's main product and its call, as data only (moved unchanged from lib/demo-seed.ts, which
 * re-exports them and seeds the store from them). The public home page lists both by name and price; it
 * reads them here, so its server code does not import the seeding module and, through its checkout and
 * purchase-email imports, send a store's buyer components to every visitor (tests/home-client-graph.test.ts).
 */
import type { DemoFileName } from "@/lib/demo-file";
import { SMALL_LONG_SIDE } from "@/lib/product-image";
import { SITE_URL } from "@/lib/site-url";

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
