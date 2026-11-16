/**
 * 269 [KT3]: each plan on the pricing page is described by the creator's stage
 * it was made for (starting out, growing, scaling up), in the line under the
 * plan's name (components/home-parts.tsx, PlanCard's bestFor), with the plan's
 * real figures from lib/plan.ts on the same card.
 *
 * What fails here:
 *   - a card whose line does not begin with its stage, or stages out of order;
 *   - a figure, a dollar sign, an income or earnings word, a superlative or a
 *     promised result in that line (VR; 561 [NE1]: a stage is what the creator
 *     is doing, never how much they make);
 *   - a line above a middle-school reading level (AX274, WCAG 3.1.5): a
 *     sentence over 22 words, a word over three syllables, or a
 *     Flesch-Kincaid grade over 8.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Pricing } from "@/components/home-parts";
import { PLAN_TITLES, TIERS } from "@/lib/plan";
import { done, is, part } from "./check";

const STAGES: Record<(typeof TIERS)[number], string> = {
  creator: "Starting out",
  pro: "Growing",
  scale: "Scaling up",
};

const html = renderToStaticMarkup(createElement(Pricing));
const cards = html.split(/(?=<div[^>]*data-pricing-card)/).slice(1);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** The line under each plan's name, read from what the page renders. */
const lines = cards.map((card) => {
  const m = card.match(/<h3[^>]*>([\s\S]*?)<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/);
  return { title: m ? text(m[1]) : "", line: m ? text(m[2]) : "" };
});

/** Vowel groups, less a silent final e: rough, and enough to catch a long word. */
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 0);
}

const FORBIDDEN = /\d|\$|%|\b(best|top|leading|ultimate|perfect|most|number one|earn\w*|income|revenue|profit\w*|money|rich|figures?|guarantee\w*|success\w*|famous|will|explode|skyrocket|boost)\b/i;

part("one card per plan, in order");
is("three cards", lines.length, TIERS.length);
TIERS.forEach((tier, i) => is(`card ${i + 1} is ${PLAN_TITLES[tier]}`, lines[i]?.title, PLAN_TITLES[tier]));

part("each line names the plan's stage first");
TIERS.forEach((tier, i) => {
  const line = lines[i]?.line ?? "";
  is(`${PLAN_TITLES[tier]} begins with "${STAGES[tier]}:"`, line.startsWith(`${STAGES[tier]}:`), true);
});
is("three different stages", new Set(lines.map((l) => l.line.split(":")[0])).size, TIERS.length);

part("no figure, income word, superlative or promise");
TIERS.forEach((tier, i) => {
  const line = lines[i]?.line ?? "";
  is(`${PLAN_TITLES[tier]}: ${JSON.stringify(line.match(FORBIDDEN)?.[0] ?? null)}`, FORBIDDEN.test(line), false);
});

part("plain English at a middle-school reading level (WCAG 3.1.5)");
TIERS.forEach((tier, i) => {
  const line = lines[i]?.line ?? "";
  const sentences = line.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  const words = line.split(/[\s—–-]+/).map((w) => w.replace(/[^A-Za-z']/g, "")).filter(Boolean);
  const longest = Math.max(...sentences.map((s) => s.split(/\s+/).filter(Boolean).length));
  is(`${PLAN_TITLES[tier]}: longest sentence ${longest} words <= 22`, longest <= 22, true);
  const hard = words.filter((w) => syllables(w) > 3);
  is(`${PLAN_TITLES[tier]}: words over three syllables ${JSON.stringify(hard)}`, hard.length, 0);
  const syl = words.reduce((sum, w) => sum + syllables(w), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (syl / words.length) - 15.59;
  is(`${PLAN_TITLES[tier]}: grade ${grade.toFixed(1)} <= 8`, grade <= 8, true);
});

part("the real figures stay on the same card");
TIERS.forEach((tier, i) => is(`${PLAN_TITLES[tier]} card still lists its allowances`, /a month/.test(text(cards[i] ?? "")), true));

done();
