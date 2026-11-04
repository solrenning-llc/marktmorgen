/**
 * The questions someone starting out asks on a page for one kind of creator
 * (534 [FQ1], unit 40, lib/audience-faq.ts; added 2 November 2026). Checked:
 * the sign-in page starting a store from an emailed link with no password;
 * the studio's "Take your address" card; the first steps every store's studio
 * lists to the owner, up to five to the first sale, from "Prepare your first
 * offer" to "Share your address", each done one with a check; the sign-in page saying so when logging in is off; the
 * shared trial answer in both states; the questions first on every page for
 * a kind of creator; no sentence said twice on any of them; no figure.
 */
import { readFileSync } from "node:fs";
import { AUDIENCE_WORDS, audienceBeginnerQuestions } from "@/lib/audience-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { TRIAL_DAYS } from "@/lib/plan";
import { PAGES as SITE_PAGES } from "@/lib/site-pages";
import { startList } from "@/lib/studio-start-rules";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const w = AUDIENCE_WORDS;

part("The site, the sign-in page and the studio");
is("the page's own button to start", flat(read("components/topic-page.tsx")).includes(`<Link href="/signin" className="btn btn-primary btn-lg"> ${w.start} <Icon`), true);
const signin = flat(read("app/signin/page.tsx"));
is("an emailed link logs in, with no password", signin.includes("No password to create."), true);
is("the sign-in page says so when logging in is off, and sends nothing", flat(read("components/signin-form.tsx")).includes("Logging in is not switched on yet, so nothing was sent."), true);
const studio = flat(read("app/studio/page.tsx"));
is("the address card", studio.includes(`> ${w.address} </p>`), true);
const form = flat(read("components/handle-form.tsx"));
is("the store name and the button", [form.includes(` ${w.name} </`), form.includes(`"${w.create}"`)], [true, true]);
const steps = studio.slice(studio.indexOf("const startSteps: StartStep[] = store ? ["), studio.indexOf("] : []; const connectTestMode"));
const all3 = [...steps.matchAll(/title: "([^"]+)"/g)].map((m) => m[1]);
// The list shows the steps to the first sale (lib/studio-start-rules.ts): "Your address", always done, is not shown.
const shown = startList([...steps.matchAll(/\{ key: "([^"]+)", title: "([^"]+)"/g)].map((m) => ({ key: m[1], title: m[2], done: false }))).steps.map((s) => s.title);
is("the steps to the first sale, from the first to the last named, the two always there", [shown[0], shown[shown.length - 1], all3.includes("Your address"), shown.includes("Your address"), steps.includes(`{ key: "product", title: "${w.first}"`), steps.includes(`{ key: "share", title: "${w.last}"`)], [w.first, w.last, true, false, true, true]);
is("the list shown to the owner, under its title, with a check on each step done", [studio.includes("{role === \"owner\" ? <StudioStart steps={startSteps}"), flat(read("components/studio-start.tsx")).includes(` ${w.list} </`), read("components/studio-start.tsx").includes('step.done ? <Icon name="check"')], [true, true, true]);

part("The answers, in both states");
const today = audienceBeginnerQuestions(false, TRIAL_DAYS);
const later = audienceBeginnerQuestions(true, TRIAL_DAYS);
is("two questions", today.map((x) => x.q), ["How do I start my own store?", "Can I try my store before paying?"]);
const start = today[0].a;
is("starting: every word in the order the creator meets it", (() => { const k = [w.start, w.address, w.name, w.create, w.list, w.first, w.last].map((x) => start.indexOf(`“${x}”`)); return k.every((x, i) => x >= 0 && (i === 0 || x > k[i - 1])); })(), true);
is("starting: no password, and nothing sent while logging in is off", [start.includes("with no password"), start.endsWith("If logging in is not switched on yet, the sign-in page says so and sends nothing.")], [true, true]);
is("trying: the one shared answer", [today[1].a, later[1].a], [tryBeforePaying("Your store", "your store, its page and your first products", false, TRIAL_DAYS), tryBeforePaying("Your store", "your store, its page and your first products", true, TRIAL_DAYS)]);
const all = [...today, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the trial's days", /\d/.test(all.split(`${TRIAL_DAYS}-day`).join("")), false);

part("On every page for a kind of creator");
const pages = SITE_PAGES.filter((p) => p.section === "for");
const faqs = pages.map((p) => (p.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined);
is("every one has them first in its Questions block", [pages.length >= 4, faqs.every((f) => JSON.stringify(f?.items.slice(0, 2).map((x) => x.q)) === JSON.stringify(today.map((x) => x.q)))], [true, true]);
is("no question asked twice on any", faqs.every((f) => new Set(f?.items.map((x) => x.q)).size === f?.items.length), true);
const shared = [false, true].map((s) => tryBeforePaying("Your store", "your store, its page and your first products", s, TRIAL_DAYS)).join(" ");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !shared.includes(x));
is("no sentence of the answers said elsewhere on any of them", pages.filter((p, i) => { const rest = JSON.stringify({ ...p, blocks: (p.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faqs[i]?.items.slice(2) } : b)) }); return today.flatMap((x) => sentences(x.a)).some((x) => rest.includes(x)); }).map((p) => p.slug), []);

done();
