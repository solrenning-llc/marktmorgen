/**
 * The order of the parts of a store page under the creator's name (added 9
 * October 2026).
 *
 * Every store page is one column: who the creator is at the top, then what
 * they sell, their welcome video, what buyers said, where else they are, a way to support them, the sign-up box, the
 * questions, the contact form and the way into the community. A creator whose
 * page is mostly links wants the links first; one whose buyers' words sell
 * best wants those above the products; one building a list wants the sign-up
 * box before anything else. So they choose the order of those parts. Not
 * where each sits beside another — the page stays one column that reads on a
 * phone — only which comes first.
 *
 * Kept as a list of the parts' names on the store's record, so drawing the
 * page reads nothing more. A part the creator has not switched on is simply
 * not drawn wherever it stands. A part added after a store chose its order
 * is put right after the part it follows in the usual order, and a name that
 * is no longer one is dropped, so a store never loses a part by having
 * arranged its page first.
 */

export const PAGE_PARTS = [
  { id: "products", label: "What you sell", note: "Your products, with the search, the sale banner and the guide that helps a visitor choose." },
  // Added 16 November 2026 (496 [ME1], unit 3): the welcome video stood under the creator's name, above the
  // products, and pushed the first one below a phone's first screen. Right after the products now, and the
  // creator can put it back above them; a store that chose an order before finds it right after its products.
  { id: "intro", label: "Welcome video", note: "Your hello from YouTube, Vimeo or Loom, loaded only when a visitor presses play. Shown when you have added one." },
  { id: "quotes", label: "What buyers say", note: "The newest reviews with words, once you have some." },
  { id: "links", label: "Your links", note: "The links with no price, and the headings over them." },
  { id: "tips", label: "Support my work", note: "Amounts a fan can give you with nothing bought. Shown when it is switched on." },
  { id: "signup", label: "Email sign-up box", note: "Shown when it is switched on." },
  { id: "faq", label: "Questions and answers", note: "Shown when you have written some." },
  { id: "contact", label: "Contact form", note: "Shown when it is switched on." },
  { id: "community", label: "Your community", note: "The way in, shown when the community is on." },
] as const;

export type PagePart = (typeof PAGE_PARTS)[number]["id"];

/** The order every store has until its creator changes it: the order the page always had. */
export const USUAL_ORDER: PagePart[] = PAGE_PARTS.map((part) => part.id);

const KNOWN = new Set<string>(USUAL_ORDER);

export function isPagePart(value: unknown): value is PagePart {
  return typeof value === "string" && KNOWN.has(value);
}

/**
 * An order from storage or from a form, made whole: each part once, unknown
 * names dropped, and any part missing put back where it falls in the usual
 * order — after the parts that come before it there.
 */
export function parseOrder(raw: unknown): PagePart[] {
  const chosen: PagePart[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (isPagePart(entry) && !chosen.includes(entry)) chosen.push(entry);
    }
  }
  for (const part of USUAL_ORDER) {
    if (chosen.includes(part)) continue;
    // Right after the part just before it in the usual order, wherever the
    // creator put that one; first, when nothing comes before it.
    const before = USUAL_ORDER.slice(0, USUAL_ORDER.indexOf(part)).reverse().find((each) => chosen.includes(each));
    chosen.splice(before ? chosen.indexOf(before) + 1 : 0, 0, part);
  }
  return chosen;
}

/** Whether an order is the usual one, so a store keeps nothing it does not need. */
export function isUsualOrder(order: PagePart[]): boolean {
  return order.length === USUAL_ORDER.length && order.every((part, i) => part === USUAL_ORDER[i]);
}

/**
 * The order the page is drawn in now. A visitor who has just searched asked
 * for products, so the results come first whatever the order.
 */
export function drawnOrder(order: PagePart[], searching: boolean): PagePart[] {
  const whole = parseOrder(order);
  return searching ? ["products", ...whole.filter((part) => part !== "products")] : whole;
}
