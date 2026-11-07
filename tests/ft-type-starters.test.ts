/**
 * A ready campaign for every funnel type that had none (FT, common rule 7 of
 * 572–576; added 7 November 2026): the challenge, the small first purchase,
 * the quiz and the book as a download. Each is a starter like the others
 * (lib/funnel-starters.ts): the same strict file, the same preview, made as
 * a draft and kept back from visitors until the creator fills it in. Its
 * words are true as they stand or are parts in [brackets] for the creator.
 */
import { readFileSync } from "node:fs";
import * as starters from "@/lib/funnel-starters";
import { FUNNEL_STARTERS, funnelStarter, starterBeforeLines, starterOutline, type FunnelStarter } from "@/lib/funnel-starters";
import { FUNNEL_TYPES } from "@/lib/funnel-types";
import { matchingStarters, starterCard } from "@/lib/funnel-starter-catalog";
import { planImport, readBundle } from "@/lib/funnel-bundle";
import { SHARE_LIMITS } from "@/lib/funnel-share-rules";
import { sensitiveFieldOf } from "@/lib/form-sensitive";
import { done, is, part } from "./check";

// Every string a campaign writes, outside the ids and settings that are never shown.
const HIDDEN = new Set(["id", "ref", "kind", "format", "schema", "slug", "target", "style", "media", "type", "wants", "form", "outcome", "product", "next"]);
const wordsOf = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => wordsOf(item, out));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) if (!HIDDEN.has(key)) wordsOf(item, out);
  return out;
};
const pieces = (s: FunnelStarter) => wordsOf([s.label, s.hint, s.bundle, s.before ?? []]).filter(Boolean);
// What it says as it stands, outside the parts in [brackets] the creator writes.
const said = (s: FunnelStarter) => pieces(s).map((t) => t.replace(/\[[^\]]*\]/g, " ")).join(" \n ");

const NEW = ["free-challenge", "small-first-purchase", "quiz-match", "book-download"];
const made = NEW.map((id) => funnelStarter(id));

part("Four new campaigns, one for each type that had none");
is("each exists", made.map(Boolean), NEW.map(() => true));
const all = made.filter((s): s is FunnelStarter => Boolean(s));
/** JSON with every object's keys in order, so two readings compare by what they hold. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
is("each is read back by the strict reader exactly as written, nothing dropped", all.map((s) => {
  const read = readBundle(s.bundle, { maxBytes: SHARE_LIMITS.creator.bundleBytes });
  return read.ok && canonical(read.bundle) === canonical(s.bundle);
}), all.map(() => true));
is("each is found by its goal in the gallery", all.map((s) => starterCard(s).goal), ["leads", "sales", "leads", "sales"]);
is("they come after every campaign there was, so nothing already listed moves", FUNNEL_STARTERS.slice(-4).map((s) => s.id), NEW);
is("a search finds each by its own words", [
  matchingStarters(FUNNEL_STARTERS.map(starterCard), "all", "challenge").map((c) => c.id),
  matchingStarters(FUNNEL_STARTERS.map(starterCard), "all", "quiz").map((c) => c.id),
  matchingStarters(FUNNEL_STARTERS.map(starterCard), "all", "low-priced").map((c) => c.id),
  matchingStarters(FUNNEL_STARTERS.map(starterCard), "all", "download book").map((c) => c.id),
], [["free-challenge"], ["quiz-match"], ["small-first-purchase"], ["book-download"]]);

part("Every funnel type has a ready campaign of the same shape");
const typeStarters = (starters as unknown as { TYPE_STARTERS?: Record<string, string[]> }).TYPE_STARTERS;
// The eight types on main today. A type added later (FT1–FT8) brings its own campaign in its own unit.
const TYPES_NOW = ["lead-magnet", "training", "challenge", "launch", "book", "first-purchase", "application", "quiz"];
is("the eight types are still the ones there are", TYPES_NOW.every((id) => FUNNEL_TYPES.some((t) => t.id === id)), true);
is("each names at least one campaign that exists", TYPES_NOW.map((id) => Boolean(typeStarters?.[id]?.length) && typeStarters![id].every((sid) => Boolean(funnelStarter(sid)))), TYPES_NOW.map(() => true));
// The products a type walks through, in order, and the ones its campaigns walk through: a free step stays free, a paid one paid.
const typeWants = (id: string) => (FUNNEL_TYPES.find((t) => t.id === id)?.slots ?? []).flatMap((slot) => (slot.kind === "product" ? [slot.wants] : []));
const starterWants = (s: FunnelStarter) => s.bundle.steps.filter((step) => step.kind === "product").map((step) => s.bundle.products.find((p) => p.ref === step.ref)?.wants);
is(
  "each campaign walks through the products its type asks for, in the same order",
  TYPES_NOW.flatMap((id) => (typeStarters?.[id] ?? []).map((sid) => {
    const s = funnelStarter(sid);
    const want = typeWants(id);
    const got = s ? starterWants(s) : [];
    return [id, sid, got.length === want.length && got.every((w, i) => want[i] === "any" || want[i] === w)];
  })),
  TYPES_NOW.flatMap((id) => (typeStarters?.[id] ?? []).map((sid) => [id, sid, true])),
);
is("the four new ones fill the types that had none", ["challenge", "first-purchase", "quiz", "book"].map((id) => typeStarters?.[id]?.includes(NEW[["challenge", "first-purchase", "quiz", "book"].indexOf(id)]) ?? false), [true, true, true, true]);

part("The challenge");
const challenge = funnelStarter("free-challenge");
is("a page, the free challenge, a page about what comes after it, the paid product, then what happens next", challenge?.bundle.steps.map((s) => `${s.kind}:${s.ref}`), ["page:p1", "product:x1", "page:p2", "product:x2", "page:p3"]);
is("the challenge is free and asks for an email; what follows is paid", challenge?.bundle.products.map((p) => p.wants), ["free", "paid"]);
const editor = readFileSync("components/course-editor.tsx", "utf8");
is("what to do first says how the days open, with the course editor's own words", [challenge?.before?.some((t) => t.includes("“Opens after (days)”")), editor.includes(">Opens after (days)<")], [true, true]);
is("and it is said in the preview and once it is made", [starterOutline(challenge!).fill[0] === challenge?.before?.[0], starterBeforeLines(challenge!).length], [true, challenge?.before?.length ?? -1]);
is("the page after it never says the paid product is needed", /\b(need|must|have to|required)\b[^.]*\b(buy|paid|product)\b/i.test(said(challenge!)), false);

part("The small first purchase");
const first = funnelStarter("small-first-purchase");
is("a page, the low-priced product, a page about the main one, the main product, then what happens next", first?.bundle.steps.map((s) => `${s.kind}:${s.ref}`), ["page:p1", "product:x1", "page:p2", "product:x2", "page:p3"]);
is("both are paid", first?.bundle.products.map((p) => p.wants), ["paid", "paid"]);
const bridge = first?.bundle.pages.find((p) => p.ref === "p2");
is("the page between says, as it stands, that the main product is not needed to use the first one", JSON.stringify(bridge).includes("You do not need it to use what you just bought."), true);
is("and that nothing more is charged unless they choose it", JSON.stringify(bridge).includes("Nothing more is charged unless you choose it."), true);

part("The quiz");
const quiz = funnelStarter("quiz-match");
const form = quiz?.bundle.forms[0];
is("one page with the quiz, then what happens next; no product is a step", [quiz?.bundle.steps.map((s) => s.kind), quiz?.bundle.steps.some((s) => s.kind === "product")], [["page", "page"], false]);
is("two results, each suggesting one of the creator's own products", form?.outcomes.map((o) => o.product), ["x1", "x2"]);
is("every answer of every question points at a result, so a result is a sum anyone can check", form?.fields.filter((f) => f.type === "choice").every((f) => f.options.length >= 2 && f.options.every((o) => form.outcomes.some((r) => r.id === o.outcome))), true);
is("the email is optional and nobody is put on a list for answering", [form?.fields.find((f) => f.type === "email")?.required, form?.offerList], [false, false]);
is("it asks nothing a scam asks for", form ? sensitiveFieldOf(form) : "no form", null);
is("not a scored quiz: no points, no score ranges", [form?.scoring, form?.outcomes.some((o) => "min" in o || "max" in o)], [undefined, false]);
is("the page says how the answers are used", quiz?.bundle.pages[0].blocks.some((b) => b.kind === "text" && b.heading === "About your answers"), true);
is("the result is never said to be a diagnosis or a promise", /diagnos|guarantee|will (get|reach|achieve)|perfect (fit|match)|personality type/i.test(said(quiz!)), false);

part("The book as a download");
const book = funnelStarter("book-download");
is("a page, the book, then what happens next", book?.bundle.steps.map((s) => s.kind), ["page", "product", "page"]);
is("a paid book that is downloaded, not shipped", [book?.bundle.products.map((p) => p.wants), book?.before ?? []], [["paid"], []]);
const bookFaq = book?.bundle.pages[0].blocks.find((b) => b.kind === "faq");
is("buyers are told its format and whether it works with a screen reader, in the creator's words", bookFaq && bookFaq.kind === "faq" ? bookFaq.items.map((i) => [i.q, /^\[.*\]$/.test(i.a)]) : null, [
  ["What format is it in?", true],
  ["Can I read it with a screen reader or larger text?", true],
  ["What is the refund policy?", true],
]);

part("What none of the four says");
const FORBIDDEN = /\d|%|limited|only today|today only|one[- ]time offer|ends soon|last chance|hurry|spots? left|seats? left|countdown|act now|don'?t miss|best[- ]?sell|most popular|#1|testimonial|proven|guaranteed|life[- ]changing|transform/i;
is("no number, deadline, scarcity, pressure, badge or promised result, said as it stands", all.filter((s) => FORBIDDEN.test(said(s))).map((s) => s.id), []);
is("nor in the parts in brackets", all.filter((s) => /limited|only today|ends soon|last chance|hurry|best[- ]?sell|testimonial|guaranteed/i.test(pieces(s).join(" "))).map((s) => s.id), []);
is("the rule catches what it is for", ["Only 3 spots left", "50% off", "Ends soon", "One-time offer", "Our best seller", "Proven method"].map((t) => FORBIDDEN.test(t)), Array(6).fill(true));
is("no block that shows ratings, quotes, counts or a countdown", all.filter((s) => s.bundle.pages.some((p) => p.blocks.some((b) => ["reviews", "quotes", "facts", "countdown"].includes(b.kind)))).map((s) => s.id), []);
// Plain words (AX274, 3.1.5): every sentence said as it stands is short.
const sentences = (s: FunnelStarter) => pieces(s).map((t) => t.replace(/\[[^\]]*\]/g, " ").trim()).filter(Boolean).flatMap((t) => t.split(/(?<=[.!?])\s+/));
is("every sentence said as it stands is at most twenty words", all.flatMap((s) => sentences(s).filter((t) => t.split(/\s+/).filter(Boolean).length > 20)), []);
is("no block id repeats on its page", all.every((s) => s.bundle.pages.every((p) => new Set(p.blocks.map((b) => b.id)).size === p.blocks.length)), true);

part("Made like any campaign: mapped to the creator's own products, as a draft");
const plan = (s: FunnelStarter, products: { id: string; title: string; free: boolean }[], map: Record<string, string>) =>
  planImport(starterOutline(s), products.map((p) => ({ ...p, call: false, draft: false })), { pagesLeft: 10, funnelsLeft: 1, formsLeft: 5 }, map);
is("the challenge with a free course and a paid one", plan(challenge!, [{ id: "c1", title: "Five-day start", free: true }, { id: "c2", title: "Full course", free: false }], { x1: "c1", x2: "c2" }).ok, true);
is("the challenge refuses a paid product where the free challenge goes", plan(challenge!, [{ id: "c1", title: "Paid", free: false }, { id: "c2", title: "Full course", free: false }], { x1: "c1", x2: "c2" }).lines.some((l) => l.level !== "ok" && l.text.includes("free product")), true);
is("the quiz with two of the creator's products as its results", plan(quiz!, [{ id: "a1", title: "Course A", free: false }, { id: "b1", title: "Course B", free: false }], { x1: "a1", x2: "b1" }).ok, true);

done();
