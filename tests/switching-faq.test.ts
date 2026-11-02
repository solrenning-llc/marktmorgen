/**
 * The questions someone starting out asks about moving to Marktmorgen (534
 * [FQ1], unit 36, lib/switching-faq.ts; added 2 November 2026). Checked: the
 * studio's own words, read from its files, in the screen's order; the tool
 * for whoever may import; members only once the store can take payments,
 * nothing else asking for a plan to start; the shared trial answer in both
 * states; no sentence said twice on the page; no figure; first in the page's
 * own Questions block.
 */
import { readFileSync } from "node:fs";
import { SWITCHING_WORDS, switchingBeginnerQuestions } from "@/lib/switching-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { TRIAL_DAYS } from "@/lib/plan";
import { can } from "@/lib/team-roles";
import { findPage } from "@/lib/site-pages";
import { startProblem } from "@/lib/imports";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = SWITCHING_WORDS;

part("The studio's own words and rules");
const studio = flat(read("app/studio/page.tsx"));
const page = flat(read("app/studio/import/page.tsx"));
const tool = flat(read("components/import-tool.tsx"));
is("the tool, for whoever may import", [studio.includes(`...(may("import") ? [{ href: studioPath(store, "", "import"), title: "${w.tool}"`), can("owner", "import"), can("admin", "import"), can("editor", "import"), can("support", "import")], [true, true, true, false, false]);
is("its four tabs, in order", (() => { const at = w.tabs.map((t) => page.indexOf(`title: "${t}"`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), true);
const at = [`"${w.file}"`, `>${w.columns}</legend>`, `>${w.rows}</caption>`, `\`${w.go} \${rows.length.toLocaleString("en-US")}`].map((x) => tool.indexOf(x));
is("the file, the columns, the first rows and the button, in the screen's order", at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])), true);
is("the two boxes, after the first rows and before the button", (() => { const rows = tool.indexOf(`>${w.rows}</caption>`); const button = tool.indexOf(`\`${w.go} \${rows.length.toLocaleString("en-US")}`); return [w.agreed, w.stopped].map((x) => { const k = tool.indexOf(`<strong>${x}</strong>`); return k > rows && k < button; }); })(), [true, true]);
const none = { sid: "s".repeat(32), catalog: { items: [] }, subscriptionActive: false, subscriptionId: null, trialEnds: 0, stripeAccountId: "", stripeChargesEnabled: false, tier: "creator" } as never;
const paid = { ...(none as object), subscriptionActive: true, subscriptionId: "sub_Move0001", stripeAccountId: "acct_x", stripeChargesEnabled: true } as never;
const go = (store: never, kind: Parameters<typeof startProblem>[1], extra: Record<string, unknown>) => startProblem(store, kind, { expected: 5, ...extra } as never)?.reason ?? null;
is("with no plan: a list (with its box), products and past buyers start; members do not", [go(none, "contacts", { agreed: true }), go(none, "products", {}), go(none, "purchases", { email: false }), go(none, "members", { stopped: true })], [null, null, null, "email"]);
is("a list needs its box, and members theirs", [go(none, "contacts", {}), go(paid, "members", {})].map((r) => r !== null), [true, true]);
is("members also need an email sender, even where the store takes payments", go(paid, "members", { stopped: true }), "email");

part("The answers, in both states");
const now = switchingBeginnerQuestions(false, TRIAL_DAYS);
const later = switchingBeginnerQuestions(true, TRIAL_DAYS);
is("two questions", now.map((x) => x.q), ["Where do I start my move to Marktmorgen?", "Can I move my store to Marktmorgen before paying?"]);
const start = answer(now, "Where do I start my move to Marktmorgen?");
is("starting: the studio's words in order", (() => { const k = [w.tool, ...w.tabs, w.file, w.columns, w.rows, w.agreed, w.stopped, `${w.go} …`].map((x) => start.indexOf(`“${x}”`)); return k.every((x, i) => x >= 0 && (i === 0 || x > k[i - 1])); })(), true);
is("trying: the shared answer, and members only once the store takes payments", [answer(now, "Can I move my store to Marktmorgen before paying?").startsWith(tryBeforePaying("A move", "your list, products and past buyers", false, TRIAL_DAYS)), answer(later, "Can I move my store to Marktmorgen before paying?").startsWith(tryBeforePaying("A move", "your list, products and past buyers", true, TRIAL_DAYS)), [now, later].every((l) => answer(l, "Can I move my store to Marktmorgen before paying?").endsWith("Your members come over only while your store can take payments and send email, because each one is emailed their own link and keeps their membership by paying here."))], [true, true, true]);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the trial's days", /\d/.test(all.split(`${TRIAL_DAYS}-day`).join("")), false);

part("On the moving page");
const topic = findPage("platform", "switching-to-marktmorgen");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 2).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const shared = [tryBeforePaying("A move", "your list, products and past buyers", false, TRIAL_DAYS), tryBeforePaying("A move", "your list, products and past buyers", true, TRIAL_DAYS)].join(" ");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !shared.includes(x));
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(2) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them", [now, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
