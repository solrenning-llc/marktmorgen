/**
 * The questions someone starting out asks about the store page (534 [FQ1],
 * unit 5, lib/store-page-faq.ts; added 2 November 2026). Checked: the sign-in
 * form's button and the store form's own labels and button, read from their
 * files; no password; the photo and links a store page has; the live demo at
 * the end of every feature page; the shared trial answer in both states; no
 * figure; first in the page's own Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { START_WORDS, storeBeginnerQuestions } from "@/lib/store-page-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const signin = flat(read("components/signin-form.tsx"));
const signinPage = flat(read("app/signin/page.tsx"));
const form = flat(read("components/handle-form.tsx"));
const topic = flat(read("components/topic-page.tsx"));
is("Start your store on the feature page, the sign-in form's button, and no password", [topic.includes(START_WORDS.start), signin.includes(`"${START_WORDS.email}"`), signinPage.includes("No password to create.")], [true, true, true]);
is("the emailed link opens a confirmation with its own button, then the studio", [read("app/api/auth/callback/route.ts").includes("/signin/confirm?token="), read("app/signin/confirm/page.tsx").includes(`label="${START_WORDS.confirm}"`)], [true, true]);
is("the studio shows the store form to an account with no store", read("app/studio/page.tsx").includes("<HandleForm initial={prefillHandle(params.handle)} />"), true);
is("the store form's labels, the line marked optional, and its button for a first store", [form.includes(START_WORDS.address), form.includes(START_WORDS.name), new RegExp(`${START_WORDS.line}\\s*<span[^>]*>\\(optional\\)`).test(form), new RegExp(`"Create this store"\\s*:\\s*"${START_WORDS.create}"`).test(form)], [true, true, true, true]);
const storePage = flat(read("app/[handle]/page.tsx"));
is("a store page shows its photo, its line and its links", [storePage.includes("src={photoUrl(store.photoId)}"), storePage.includes("store.bio"), storePage.includes("const links = showingLinks(store.links);")], [true, true, true]);
is("the live demo is linked at the end of every feature page, and is marked as made up", [topic.includes('<Link href="/demo" className="link-arrow">'), read("lib/demo-seed.ts").includes("Jenny, a fictional cook")], [true, true]);

part("The answers");
const now = storeBeginnerQuestions(false);
const later = storeBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What is a store page here?", "How do I start one?", "Can I try it before paying?", "Do store pages work?"]);
is("start: the buttons and labels on the way, in order", (() => { const a = answer(now, "How do I start one?"); const at = [START_WORDS.start, START_WORDS.email, START_WORDS.confirm, START_WORDS.address, START_WORDS.name, START_WORDS.line, START_WORDS.create].map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), true);
is("try before paying: the one shared answer, in a store page's words", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?")], [tryBeforePaying("A store page", "your page", false), tryBeforePaying("A store page", "your page", true, TRIAL_DAYS)]);
is("the demo is pointed to once, by the shared answer, not again by the next one", [answer(now, "Can I try it before paying?").includes("open the live demo store"), answer(now, "Do store pages work?").includes("open the live demo store")], [true, false]);
is("\"store\" not said twice in a row in the trial answer", answer(now, "Can I try it before paying?").includes("set up your page in your own store's studio"), true);
is("one space between sentences, never two", /\s{2}/.test(now.map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of stores, visits or sales, no percent, no result promised", /\b\d{2,}\s+(stores|visits|buyers|creators|sales)|%|guarantee|proven|results?\b/i.test(all), false);

part("On the store page");
const faq = (findPage("platform", "store-page")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
