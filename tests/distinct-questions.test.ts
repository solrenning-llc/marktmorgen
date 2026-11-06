/**
 * Every page's Questions block, together (534 [FQ1] (g) and (h), unit 42;
 * added 2 November 2026). Checked on every page of the site: a question asked
 * on two pages gets the same answer on both, so nobody reads two answers to
 * one question; the feature pages' trial question names its own feature; no
 * question or answer starts with "Free"; no answer links over http:// or
 * says "proven", "guaranteed", "24/7", "boom" or "in minutes" (a link that
 * "expires in minutes" aside: that is a limit, not a promise); no answer
 * promises how long building something takes; and the FAQPage data search
 * engines read is built from the same items the page shows, with no copy.
 * Only the site's current state is read (PLANS_ON_SALE false, domains as
 * configured); each page's own test reads its answers in both states. The
 * home page, pricing, the help center and the blog are read too (unit 44):
 * a question the help center already answers is answered on a feature page
 * with the help center's own words (helpAnswer, lib/help-content.ts); only
 * the home page's two short answers to pricing's questions differ, by the
 * owner's VS1 (31/10/2026), and they link to the rest.
 */
import { readFileSync } from "node:fs";
import { PAGES } from "@/lib/site-pages";
import { HOME_QUESTIONS } from "@/lib/home-faq";
import { PRICING_QUESTIONS } from "@/lib/pricing-page-data";
import { HELP_SECTIONS } from "@/lib/help-content";
import { BLOG_POSTS } from "@/lib/blog";
import { done, is, part } from "./check";

type Item = { q: string; a: string };
const faqs = PAGES.map((p) => ({ slug: p.slug, items: (p.blocks ?? []).flatMap((b) => ((b as { kind?: string }).kind === "faq" ? (b as unknown as { items: Item[] }).items : [])) }));
const all = faqs.flatMap((f) => f.items.map((it) => ({ ...it, slug: f.slug })));
// The other places the site answers questions (unit 44): the home page, pricing, the help center and the blog.
const elsewhere = [
  ...HOME_QUESTIONS.map((it) => ({ q: it.q, a: it.a, slug: "home" })),
  ...PRICING_QUESTIONS.map((it) => ({ q: it.q, a: it.a, slug: "pricing" })),
  ...HELP_SECTIONS.flatMap((s) => s.items.map((it) => ({ q: it.q, a: it.a.join(" "), slug: `help:${s.id}` }))),
  ...BLOG_POSTS.flatMap((post) => (post.faq ?? []).map((it) => ({ q: it.q, a: it.a, slug: `blog:${post.slug}` }))),
];
// The owner's VS1 (31/10/2026): the home page asks two of pricing's questions with a short answer and links to the long one on /pricing.
const SHORT_ON_HOME = ["how long does it take to open a store", "how much does it cost"];

part("One answer to each question");
// Compared without case or punctuation, so "Can I cancel?" and "can I cancel" are one question.
const key = (q: string) => q.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
const answers = new Map<string, Set<string>>();
for (const it of all) answers.set(key(it.q), (answers.get(key(it.q)) ?? new Set()).add(it.a));
is("enough questions read to mean something", all.length >= 200, true);
is("no question with two answers", [...answers].filter(([, a]) => a.size > 1).map(([q]) => q), []);
const everywhere = new Map<string, Set<string>>();
// Only the home page's own two short answers are set aside; pricing and every other place still have one answer each.
for (const it of [...all, ...elsewhere].filter((x) => !(x.slug === "home" && SHORT_ON_HOME.includes(key(x.q))))) everywhere.set(key(it.q), (everywhere.get(key(it.q)) ?? new Set()).add(it.a));
is("none with two answers across the home page, pricing, the help center and the blog either (the home page's short two aside, VS1)", [elsewhere.length >= 100, [...everywhere].filter(([, a]) => a.size > 1).map(([q]) => q)], [true, []]);
is("the home page's short two link to the long answers on /pricing", SHORT_ON_HOME.map((q) => HOME_QUESTIONS.find((it) => key(it.q) === q)?.links?.some((l) => l.href === "/pricing") ?? false), [true, true]);
const featurePages = faqs.filter((f) => PAGES.find((p) => p.slug === f.slug)?.section === "platform" && f.items.length > 0 && f.slug !== "security");
const trialQ = /^Can I .* before (paying|I pay for a plan)\?$/;
is("each feature page asks its trial question once, naming its feature", [featurePages.length >= 30, featurePages.filter((f) => f.items.filter((it) => trialQ.test(it.q) && !/^Can I try (it|this|that|one) /.test(it.q)).length !== 1).map((f) => f.slug)], [true, []]);
is("no question that names nothing (\"How do I start one?\")", all.filter((it) => !it.q.includes(",") && /\b(it|one|this|them|that)\?$/i.test(it.q)).map((it) => `${it.slug}: ${it.q}`), []);

part("What no question or answer says");
is("none starts with Free", all.filter((it) => /^free\b/i.test(it.q) || /^free\b/i.test(it.a)).map((it) => it.q), []);
is("no link over http://", all.filter((it) => /http:\/\//.test(it.a)).map((it) => it.q), []);
is("no forbidden words", all.filter((it) => /\bproven\b|\bguarantee|24\/7|\bboom\b|(?<!expires )\bin minutes\b/i.test(it.a)).map((it) => `${it.slug}: ${it.q}`), []);
is("no build time promised", all.filter((it) => /takes (a|one) minute|in (a|one) minute|in seconds/i.test(it.a)).map((it) => `${it.slug}: ${it.q}`), []);

part("The data search engines read");
const topic = readFileSync("components/topic-page.tsx", "utf8").replace(/\s+/g, " ");
is("built from the shown items, question and answer, with no second copy", [topic.includes('const items = blocks.flatMap((b) => (b.kind === "faq" ? b.items : []));'), topic.includes('name: item.q, acceptedAnswer: { "@type": "Answer", text: item.a },')], [true, true]);

done();
