/**
 * Two versions of one email's words, and the rest of the list getting the one
 * that did better (107 [E2-BROADCAST-CONTENT-AB], unit 1). The rules, as the
 * browser can read them too; sending them is the next unit (lib/broadcasts.ts),
 * so until then nothing calls this and no email changes.
 *
 * It is the subject-line test of lib/mail-test.ts with the words changed
 * instead of the subject, and it keeps every promise that test keeps:
 *
 *   - No pixel, no open, no tracked person. What decides is what the email is
 *     for: visits to the store or sales, per email sent, counted from the
 *     tag each version's links already carry (lib/mail-links.ts), without
 *     knowing who anybody is.
 *   - The same random split, the same shares and hours, the same smallest
 *     list (MIN_TEST_REACH) and the same decision: the winner is always the
 *     one chooseSubject would pick from the same counts (held by the test).
 *     A count that could not be read, or a tie, sends the first version and
 *     says it was not chosen on merit.
 *
 * And three of its own, so a result means something:
 *
 *   - One change at a time: never together with a second subject line, or
 *     nobody could tell which change did it.
 *   - Each version needs a link to the creator's own store: without one there
 *     is nothing to count, and the "winner" would be the first every time.
 *   - The creator's words are kept as written: a second version longer than
 *     an email may be is refused, never cut, and a template's part left to
 *     write is refused as it is for the first version (lib/mail-body.ts).
 */
import { hasPlaceholder } from "@/lib/mail-body";
import { type Counted, type TestBy, type Variant, TEST_BY, TEST_HOURS, TEST_SHARES, chooseSubject } from "@/lib/mail-test";

export type ContentTest = {
  /** The second version of the email's words. */
  bodyB: string;
  share: number;
  hours: number;
  by: TestBy;
  /** How many got each version. */
  a: number;
  b: number;
  endsAt: number;
  winner: Variant | "";
  visits: Counted;
  sales: Counted;
  why: string;
  skipped: boolean;
};

export type ContentProblem = "both" | "body" | "same" | "long" | "placeholder" | "link";

export const CONTENT_PROBLEMS: Record<ContentProblem, string> = {
  both: "Test one thing at a time: a second subject line or a second version of the words, not both.",
  body: "Write the second version of the email, or turn the test off.",
  same: "The second version says the same as the first. Change the words, or turn the test off.",
  long: "The second version is longer than an email can be. Make it shorter; nothing was cut.",
  placeholder: "The second version still has a part of the template to write (in ⟦ ⟧). Write it, or take it out.",
  link: "Each version needs a link to your store: what the links bring is what picks the winner.",
};

const whole = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** A stored pair of counts, read exactly: one that does not read makes the pair unknown, never a 0 or a count cut down (rule 24). */
const pair = (value: unknown): Counted => {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return count(v.a) && count(v.b) ? { a: v.a, b: v.b } : null;
};
const choices = (value: Record<string, unknown>) => ({
  share: TEST_SHARES.includes(value.share as number) ? (value.share as number) : TEST_SHARES[0],
  hours: TEST_HOURS.includes(value.hours as number) ? (value.hours as number) : TEST_HOURS[1],
  by: TEST_BY.includes(value.by as TestBy) ? (value.by as TestBy) : ("visits" as TestBy),
});
const flat = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * A second version asked for with a new email: "none" when none was, the
 * problem when it could not be a real test, or the test to keep.
 * `bodyA` is the first version as it will be sent; `linksToStore` is the
 * check lib/broadcasts.ts already makes for the subject test.
 */
export function newContentTest(
  raw: unknown,
  ctx: { bodyA: string; maxBody: number; subjectTest: boolean; linksToStore: (body: string) => boolean },
): ContentTest | "none" | ContentProblem {
  if (!raw || typeof raw !== "object") return "none";
  const value = raw as Record<string, unknown>;
  if (value.bodyB === undefined || value.bodyB === null) return "none";
  if (ctx.subjectTest) return "both";
  const bodyB = typeof value.bodyB === "string" ? value.bodyB.replace(/\r\n?/g, "\n").trim() : "";
  if (!bodyB) return "body";
  if (flat(bodyB) === flat(ctx.bodyA)) return "same";
  if (bodyB.length > ctx.maxBody) return "long";
  if (hasPlaceholder(bodyB)) return "placeholder";
  if (!ctx.linksToStore(ctx.bodyA) || !ctx.linksToStore(bodyB)) return "link";
  return { bodyB, ...choices(value), a: 0, b: 0, endsAt: 0, winner: "", visits: null, sales: null, why: "", skipped: false };
}

/** What was stored, made safe; null when it holds no second version. */
export function parseContentTest(raw: unknown): ContentTest | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.bodyB !== "string" || !value.bodyB) return null;
  return {
    bodyB: value.bodyB,
    ...choices(value),
    a: whole(value.a),
    b: whole(value.b),
    endsAt: whole(value.endsAt),
    winner: value.winner === "a" || value.winner === "b" ? value.winner : "",
    visits: pair(value.visits),
    sales: pair(value.sales),
    why: typeof value.why === "string" ? value.why.slice(0, 400) : "",
    skipped: value.skipped === true,
  };
}

const n = (x: number) => x.toLocaleString("en-US");
const times = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`;

/**
 * Which version the rest of the list gets, and the sentence that says why,
 * with the counts it was decided on. The decision is chooseSubject's; only
 * the words differ.
 */
export function chooseContent(test: Pick<ContentTest, "a" | "b" | "by">, visits: Counted, sales: Counted): { winner: Variant; why: string } {
  const { winner } = chooseSubject(test, visits, sales);
  const other = (v: Variant): Variant => (v === "a" ? "b" : "a");
  const name = (v: Variant) => (v === "a" ? "The first version" : "The second version");
  const ahead = (count: Counted, v: Variant) => Boolean(count && test.a && test.b && count[v] / test[v] > count[other(v)] / test[other(v)]);
  const visitWords = (c: { a: number; b: number }, v: Variant) =>
    `${times(c[v], "visit", "visits")} to your store from ${times(test[v], "email", "emails")}, against ${n(c[other(v)])} from ${n(test[other(v)])}`;
  const saleWords = (c: { a: number; b: number }, v: Variant) =>
    `${times(c[v], "sale", "sales")} from ${times(test[v], "email", "emails")}, against ${n(c[other(v)])} from ${n(test[other(v)])}`;

  if (test.by === "sales" && sales && ahead(sales, winner)) return { winner, why: `${name(winner)} brought ${saleWords(sales, winner)}, so the rest got it.` };
  if (visits && ahead(visits, winner)) {
    if (test.by === "visits") return { winner, why: `${name(winner)} brought ${visitWords(visits, winner)}, so the rest got it.` };
    return {
      winner,
      why: `${sales ? "Neither version had sold more when the time was up" : "Sales could not be read when the time was up"}, so visits decided: ${name(winner).toLowerCase()} brought ${visitWords(visits, winner)}. The rest got it.`,
    };
  }
  // Sales were what decides, and could not be read: said so, never as a tie (Codex G on #3654).
  if (test.by === "sales" && !sales && visits) {
    return { winner, why: "Sales could not be read when the time was up, and visits did not set the versions apart, so the rest got the first one. It was not chosen on merit." };
  }
  if (!visits && (test.by === "visits" || !sales)) {
    return { winner, why: "The counts could not be read when the time was up, so the rest got the first version. It was not chosen on merit." };
  }
  return { winner, why: "Neither version did better than the other in the time you gave it, so the rest got the first one. It was not chosen on merit." };
}
