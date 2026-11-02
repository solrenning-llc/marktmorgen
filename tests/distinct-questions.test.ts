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
 * home page, pricing, the blog and the help center have Questions of their
 * own outside these pages (docs/codex-queue.md, FQ1 unit 44).
 */
import { readFileSync } from "node:fs";
import { PAGES } from "@/lib/site-pages";
import { done, is, part } from "./check";

type Item = { q: string; a: string };
const faqs = PAGES.map((p) => ({ slug: p.slug, items: (p.blocks ?? []).flatMap((b) => ((b as { kind?: string }).kind === "faq" ? (b as unknown as { items: Item[] }).items : [])) }));
const all = faqs.flatMap((f) => f.items.map((it) => ({ ...it, slug: f.slug })));

part("One answer to each question");
// Compared without case or punctuation, so "Can I cancel?" and "can I cancel" are one question.
const key = (q: string) => q.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
const answers = new Map<string, Set<string>>();
for (const it of all) answers.set(key(it.q), (answers.get(key(it.q)) ?? new Set()).add(it.a));
is("enough questions read to mean something", all.length >= 200, true);
is("no question with two answers", [...answers].filter(([, a]) => a.size > 1).map(([q]) => q), []);
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
