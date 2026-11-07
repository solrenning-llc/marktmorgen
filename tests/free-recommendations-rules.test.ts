/**
 * Free recommendations between stores (119 [F2-FREE-RECOMMENDATIONS], unit 1:
 * lib/free-recommendations-rules.ts). The creator picks up to three other
 * stores, each with a line of their own words. The rule is pure: it reads the
 * creator's list strictly, never lets a recommendation carry the reader's
 * email or sign anyone up, and shows a recommendation only when the store it
 * points to is confirmed live. Nothing is read, written or shown yet.
 */
import {
  MAX_RECOMMENDATIONS,
  MAX_WHY,
  problemWords,
  readRecommendations,
  recommendationHref,
  recommendationLinkWords,
  shownRecommendations,
  type RecommendationProblem,
  type StoreLiveness,
} from "@/lib/free-recommendations-rules";
import { done, is, part } from "./check";

const OWN = "maya-bakes";
const ok = (raw: unknown, own = OWN) => {
  const read = readRecommendations(raw, own);
  return read.ok ? read.list : null;
};
const problem = (raw: unknown, own = OWN): [RecommendationProblem, number | null] | null => {
  const read = readRecommendations(raw, own);
  return read.ok ? null : [read.problem, read.index];
};

part("The limits");
is("at most three stores", MAX_RECOMMENDATIONS, 3);
is("a line of at most 140 characters", MAX_WHY, 140);

part("Reading the creator's list");
is("never set: none", ok(undefined), []);
is("an empty list: none", ok([]), []);
is(
  "two stores with their lines",
  ok([
    { handle: "sam.writes", why: "Short, honest notes on writing every week." },
    { handle: "tide-garden", why: "The best guide to small gardens I know." },
  ]),
  [
    { handle: "sam.writes", why: "Short, honest notes on writing every week." },
    { handle: "tide-garden", why: "The best guide to small gardens I know." },
  ],
);
is("an address typed with @, spaces and capitals", ok([{ handle: "  @Sam.Writes ", why: "Good." }]), [{ handle: "sam.writes", why: "Good." }]);
is("spaces inside the line are tidied", ok([{ handle: "sam.writes", why: "  Good   notes,\n weekly.  " }]), [{ handle: "sam.writes", why: "Good notes, weekly." }]);
is("exactly three", ok([{ handle: "aa1", why: "a" }, { handle: "bb2", why: "b" }, { handle: "cc3", why: "c" }])?.length, 3);
is("a line of exactly 140 characters", ok([{ handle: "sam.writes", why: "x".repeat(MAX_WHY) }])?.[0].why.length, MAX_WHY);

part("Anything unexpected is refused whole, never half-read");
for (const bad of [null, "sam.writes", 3, true, { handle: "sam.writes", why: "x" }]) is(`not a list: ${JSON.stringify(bad)}`, problem(bad), ["list", null]);
is("four stores", problem([{ handle: "aa1", why: "a" }, { handle: "bb2", why: "b" }, { handle: "cc3", why: "c" }, { handle: "dd4", why: "d" }]), ["too-many", null]);
for (const bad of [null, "sam.writes", 7, [], ["sam.writes", "x"]]) is(`an entry that is not one store: ${JSON.stringify(bad)}`, problem([bad]), ["item", 0]);
is("an extra field is refused, not dropped", problem([{ handle: "sam.writes", why: "x", paid: true }]), ["item", 0]);
is("a missing line", problem([{ handle: "sam.writes" }]), ["item", 0]);
is("a missing address", problem([{ why: "x" }]), ["item", 0]);
is("an address that is not text", problem([{ handle: 12, why: "x" }]), ["item", 0]);
is("a line that is not text", problem([{ handle: "sam.writes", why: ["x"] }]), ["item", 0]);
for (const bad of ["", "a", "-sam", "sam-", "sam writes", "sam/writes", "sam?ref=1", "https://marktmorgen.com/@sam", "x".repeat(25)]) {
  is(`an address no store can have: ${JSON.stringify(bad)}`, problem([{ handle: bad, why: "x" }]), ["handle", 0]);
}
is("the store itself", problem([{ handle: OWN, why: "x" }]), ["own", 0]);
is("the store itself, typed differently", problem([{ handle: " @Maya-Bakes", why: "x" }]), ["own", 0]);
is("the same store twice", problem([{ handle: "sam.writes", why: "a" }, { handle: "@SAM.writes", why: "b" }]), ["repeat", 1]);
is("an empty line", problem([{ handle: "sam.writes", why: "   " }]), ["why-empty", 0]);
is("a line one character too long", problem([{ handle: "sam.writes", why: "x".repeat(MAX_WHY + 1) }]), ["why-long", 0]);
for (const bad of [
  "Read it at https://example.com",
  "See www.example.com",
  "Mail sam@example.com",
  "Call +1 415 555 0134",
  "Go to example.com today",
]) {
  is(`a line with a link, an email address or a phone number: ${JSON.stringify(bad)}`, problem([{ handle: "sam.writes", why: bad }]), ["why-contact", 0]);
}
for (const bad of ["<script>alert(1)</script>", "Nice <img src=x onerror=alert(1)>", "javascript:alert(1)", "bell\u0007"]) {
  is(`a line with markup or a control character: ${JSON.stringify(bad)}`, problem([{ handle: "sam.writes", why: bad }]), ["why-unsafe", 0]);
}
is("the first problem is the one named", problem([{ handle: "sam.writes", why: "ok" }, { handle: OWN, why: "x" }, { handle: "x", why: "" }]), ["own", 1]);
is("the creator's own store address must be a real one", problem([], ""), ["own", null]);
is("an own address of the wrong shape is refused", problem([{ handle: "sam.writes", why: "x" }], "Not A Handle"), ["own", null]);

part("Words the studio shows for each problem");
const problems: RecommendationProblem[] = ["list", "too-many", "item", "handle", "own", "repeat", "why-empty", "why-long", "why-contact", "why-unsafe"];
for (const p of problems) {
  const words = problemWords(p, 1);
  is(`${p}: a sentence`, typeof words === "string" && words.length > 10 && words.endsWith("."), true);
  is(`${p}: no promise of a result`, /guarantee|grow|more subscribers|sales/i.test(words), false);
}
is("names the recommendation by its place", problemWords("handle", 1), "Recommendation 2: type the store's address, like sam.writes, as it appears after marktmorgen.com/@.");
is("the limit, in words", problemWords("too-many", null), "You can recommend up to 3 stores.");
is("a line too long, with the limit", problemWords("why-long", 0), "Recommendation 1: keep the line to 140 characters or fewer.");
is("why no links: the button already goes there", problemWords("why-contact", 0), "Recommendation 1: leave out links, email addresses and phone numbers. The button already opens that store's page.");

part("The link carries nothing but the store's address");
is("the store's own page, nothing else", recommendationHref("sam.writes"), "/@sam.writes");
is("never an email, a ref or a tracking parameter", /[?#&=]/.test(recommendationHref("sam.writes")), false);
is("a link whose purpose reads on its own", recommendationLinkWords("sam.writes"), "Visit @sam.writes on Marktmorgen");
is("a bad address makes no link", recommendationHref("../admin"), null);

part("Shown only when the store is confirmed live");
const list = [
  { handle: "sam.writes", why: "a" },
  { handle: "tide-garden", why: "b" },
  { handle: "old-shop", why: "c" },
];
const statuses: Record<string, StoreLiveness> = { "sam.writes": "live", "tide-garden": "unknown", "old-shop": "gone" };
is("live shown, unknown and gone hidden", shownRecommendations(list, OWN, (handle) => statuses[handle]), [{ handle: "sam.writes", why: "a" }]);
is("a status that is not one of the three: hidden", shownRecommendations(list, OWN, () => "yes" as unknown as StoreLiveness), []);
is(
  "a lookup that fails: hidden, the page still works",
  shownRecommendations(list, OWN, () => {
    throw new Error("down");
  }),
  [],
);
is("a list that does not read: nothing at all, never part of it", shownRecommendations([...list, { handle: OWN, why: "x" }], OWN, () => "live"), []);
is("never set: nothing", shownRecommendations(undefined, OWN, () => "live"), []);
is("in the creator's order", shownRecommendations(list, OWN, () => "live").map((r) => r.handle), ["sam.writes", "tide-garden", "old-shop"]);

done();
