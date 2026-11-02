/**
 * The questions someone starting out asks about memberships (534 [FQ1],
 * unit 3, lib/membership-faq.ts; added 2 November 2026), and the one answer
 * every feature page gives to "Can I try it before paying?"
 * (lib/beginner-faq.ts). Checked: the editor's and the numbers page's own
 * words, read from their files; the trial answer follows PLANS_ON_SALE and
 * the upload policy, and is the same shared answer on the courses page; no
 * figure about members or sales; first in the page's own Questions block,
 * no question asked twice.
 */
import { readFileSync } from "node:fs";
import { MEMBERSHIP_EDITOR_WORDS, MEMBERSHIP_NUMBERS, membershipBeginnerQuestions } from "@/lib/membership-faq";
import { courseBeginnerQuestions } from "@/lib/course-faq";
import { tryBeforePaying, uploadsWait } from "@/lib/beginner-faq";
import { AUTOMATIC_UPLOAD_CAPS } from "@/lib/upload-budget-policy";
import { INTERVALS } from "@/lib/product-recurring";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const editor = read("components/product-editor.tsx");
is("the editor's field, its one-off choice, and its buttons for a new product and for one already there", [editor.includes(MEMBERSHIP_EDITOR_WORDS.field), editor.includes(`<option value="">${MEMBERSHIP_EDITOR_WORDS.once}</option>`), editor.includes(`submitLabel="${MEMBERSHIP_EDITOR_WORDS.add}"`), editor.includes(`submitLabel="${MEMBERSHIP_EDITOR_WORDS.save}"`)], [true, true, true, true]);
is("the four intervals the editor offers", INTERVALS, ["day", "week", "month", "year"]);
const numbers = read("app/studio/memberships/page.tsx");
is("the numbers page's own name and the tiles it always shows once Stripe is read", [numbers.includes(`>${MEMBERSHIP_NUMBERS.page}<`), MEMBERSHIP_NUMBERS.tiles.every((t) => numbers.includes(`label: "${t}"`)), numbers.includes("Connect your Stripe account, and your memberships are counted here.")], [true, true, true]);
const store = read("lib/store.ts");
is("a call, a bundle and a shipped product are never charged again", [store.includes('if (product.call && (fields.priceCents === 0 || recurring)) return { ok: false, reason: "call" };'), /isBundle\(product\) && \(fields\.priceCents === 0 \|\| recurring/.test(store), /product\.shipping && \(fields\.priceCents === 0 \|\| recurring/.test(store)], [true, true, true]);
is("a private podcast can be a membership, as the editor says", editor.includes("A course or podcast sold as a membership"), true);

part("The answers");
const now = membershipBeginnerQuestions(false);
const later = membershipBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What is a membership here?", "How do I start one?", "Can I try it before paying?", "Do memberships work?"]);
is("every day, week, month or year, as the intervals are", answer(now, "What is a membership here?").includes("charges again every day, week, month or year"), true);
is("never \"the same amount\": introductory and yearly prices and discounts exist", /same amount/.test(answer(now, "What is a membership here?")), false);
is("start: the editor's own field, choice and buttons", [MEMBERSHIP_EDITOR_WORDS.field, MEMBERSHIP_EDITOR_WORDS.once, MEMBERSHIP_EDITOR_WORDS.add, MEMBERSHIP_EDITOR_WORDS.save].every((w) => answer(now, "How do I start one?").includes(`“${w}”`)), true);
is("try before paying: the one shared answer, in a membership's words", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?")], [tryBeforePaying("A membership", "a product as a membership", false), tryBeforePaying("A membership", "a product as a membership", true, TRIAL_DAYS)]);
is("and the courses page gives the same answer in a course's words", answer(courseBeginnerQuestions(false), "Can I try it before paying?"), tryBeforePaying("A course", "a course with its modules and the text of its lessons", false));
is("uploads said as the policy has them", [AUTOMATIC_UPLOAD_CAPS.setup.opens, answer(now, "Can I try it before paying?").includes(uploadsWait("setup")), uploadsWait("setup")], [0, true, "Files and lesson videos can be uploaded once a paid plan starts."]);
is("one space between sentences, never two", /\s{2}/.test(now.map((x) => x.a).join(" ")), false);
is("does it work: no figure, the creator's own page and tiles, once Stripe can be read", [answer(now, "Do memberships work?").startsWith("We publish no number of members or sales"), MEMBERSHIP_NUMBERS.tiles.every((t) => answer(now, "Do memberships work?").includes(`“${t}”`)), answer(now, "Do memberships work?").includes("connected and can be read")], [true, true, true]);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of members, buyers or sales, no percent, no result promised", /\b\d{2,}\s+(members|buyers|creators|sales)|%|guarantee|proven|results?\b/i.test(all), false);

part("On the memberships page");
const faq = (findPage("platform", "memberships")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in its own Questions block", [faq?.title, faq?.items.slice(0, 4).map((x) => x.q)], ["Questions about memberships", now.map((x) => x.q)]);
is("no question asked twice on the page", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
done();
