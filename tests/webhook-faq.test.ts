/**
 * The questions someone starting out asks about webhooks (534 [FQ1], unit 16,
 * lib/webhook-faq.ts; added 2 November 2026). Checked: the studio card's own
 * words, read from its file; every event checked to start; the secret shown
 * once; the most addresses; no deliveries without a plan, from the
 * allowances; the shared trial answer in both states; Zapier through its own
 * Catch Hook, as the page's limits say; first in the page's own Questions
 * block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { WEBHOOK_WORDS, webhookBeginnerQuestions } from "@/lib/webhook-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { MAX_ENDPOINTS } from "@/lib/webhook-limits";
import { NON_PAYING_ALLOWANCES } from "@/lib/store-allowance-rules";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const card = flat(read("components/webhook-editor.tsx"));
is("the card's title, field, events, button and test", Object.values(WEBHOOK_WORDS).every((w) => card.includes(w)), true);
is("every event is checked to start, and again after an add", [/useState<[^>]*>\(ALL\)|useState\(ALL\)/.test(card), card.includes("setChosen(ALL);")], [true, true]);
is("the signing secret is shown once", card.includes("Shown this once."), true);
is("the card shows for a role that may change settings", /may\("settings"\)\s*\?\s*webhooksView\(current\)/.test(flat(read("app/studio/page.tsx"))), true);
const hooks = flat(read("lib/webhooks.ts"));
const sendTest = hooks.slice(hooks.indexOf("export async function sendTest("), hooks.indexOf("export async function sendTest(") + 1500);
is("no webhook deliveries without a plan or after it ended, some in a trial, and a test takes one", [NON_PAYING_ALLOWANCES.none.webhook, NON_PAYING_ALLOWANCES.ended.webhook, NON_PAYING_ALLOWANCES.trial.webhook > 0, /takeAllowance\(store, "webhook", 1/.test(sendTest)], [0, 0, true, true]);
is("sales, memberships and refunds within about five minutes, as the card says", card.includes("sales, memberships and refunds within about five minutes, when Stripe is read"), true);
is("every kind of event the answer names is one the code sends", ["sale.completed", "refund.issued", "membership.started", "membership.canceled", "lead.captured", "list.joined", "call.booked", "sequence.step"].every((e) => hooks.includes(`"${e}"`)), true);
is("no test while a plan payment is unpaid or disputed", /integrationPauseWord\(store\)/.test(read("app/api/store/webhooks/route.ts")), true);
is("the page's own limit: no Marktmorgen app in Zapier's directory, use Catch Hook", JSON.stringify(findPage("platform", "webhooks")).includes("There is no Marktmorgen app in Zapier's directory. In Zapier, use its Webhooks by Zapier trigger, Catch Hook."), true);

part("The answers");
const now = webhookBeginnerQuestions(false);
const later = webhookBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What are webhooks here?", "How do I add one?", "Can I try it before paying?", "Do webhooks work with Zapier?"]);
is("the most addresses from the code, and when messages are sent", [answer(now, "What are webhooks here?").includes(`Up to ${MAX_ENDPOINTS} addresses per store.`), answer(now, "What are webhooks here?").includes("within about five minutes"), /as they happen/.test(answer(now, "What are webhooks here?"))], [true, true, false]);
is("add: the card's own words, in order, the events checked to start, the secret once", [(() => { const a = answer(now, "How do I add one?"); const at = Object.values(WEBHOOK_WORDS).map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), answer(now, "How do I add one?").includes("(all are checked to start)"), answer(now, "How do I add one?").includes("shown to you once"), answer(now, "How do I add one?").includes(`Once your store has a plan or its trial, press “${WEBHOOK_WORDS.test}”`)], [true, true, true, true]);
const noPlan = " Without a plan, nothing is sent, not even a test: a store with no plan, or whose plan ended, has no webhook deliveries to use, and a test counts as one.";
const inTrial = " During the trial, messages are sent within the trial's own smaller monthly number of deliveries.";
is("try before paying: the shared answer, then nothing sent without a plan", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?")], [tryBeforePaying("A webhook", "a webhook address and its events", false) + noPlan, tryBeforePaying("A webhook", "a webhook address and its events", true, TRIAL_DAYS) + inTrial + noPlan]);
is("Zapier: yes, through Catch Hook, with no app of ours in its directory", [answer(now, "Do webhooks work with Zapier?").startsWith("Yes, through Zapier's own Webhooks by Zapier trigger, Catch Hook"), answer(now, "Do webhooks work with Zapier?").includes("There is no Marktmorgen app in Zapier's directory"), answer(now, "Do webhooks work with Zapier?").includes("check that your Zapier plan includes it")], [true, true, true]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of deliveries or sales, no percent, no result promised", /\b\d+\s+(deliveries|sales|buyers|creators)|\d+%|guarantee|proven|results?\b/i.test(all), false);

part("On the webhooks page");
const faq = (findPage("platform", "webhooks")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
