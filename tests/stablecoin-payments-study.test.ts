import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Documentary checks for docs/stablecoin-payments-study.md (402 [WX3]), from Codex J's
// review of #2922 (LOW findings 1-4). They hold wording, not provider facts: every
// Stripe claim stays subject to a full re-read of the live page before any build.
const readStudy = () => readFileSync("docs/stablecoin-payments-study.md", "utf8");
const linesWith = (text: string, needle: string) => text.split("\n").filter((line) => line.includes(needle));
/** Every https address the study cites, parsed, so a source is matched by its host and path, never as a piece of text. */
const citedUrls = (text: string): URL[] => [...text.matchAll(/https:\/\/[^\s|)\]>"'`]+/g)].flatMap((m) => (URL.canParse(m[0]) ? [new URL(m[0])] : []));
const cites = (text: string, host: string, path: string) => citedUrls(text).some((url) => url.protocol === "https:" && url.hostname === host && url.pathname === path);

test("geography separates general availability, private preview and account approval (finding 1)", () => {
  const text = readStudy();
  // The overview's private-preview acceptance regions are named, not folded into "not offered".
  for (const region of ["European Union", "Hong Kong", "Mexico", "Switzerland"]) assert.ok(text.includes(region), region);
  assert.match(text, /private preview[^\n]{0,200}(?:European Union|Hong Kong|Mexico|Switzerland)|(?:European Union|Hong Kong|Mexico|Switzerland)[^\n]{0,200}private preview/);
  assert.match(text, /general availability/i);
  assert.match(text, /account approval/i);
  assert.match(text, /does not establish eligibility for any creator/i);
  // The too-broad statements are gone.
  assert.doesNotMatch(text, /Eurozone stablecoin items Stripe lists are wallet\/card products/);
  assert.doesNotMatch(text, /\*\*United States only, every state except New York\.\*\*/);
  assert.doesNotMatch(text, /EEA: not offered/);
  assert.doesNotMatch(text, /EEA creators cannot (?:accept stablecoins|use it)/);
  assert.doesNotMatch(text, /acceptance is US-only/);
});

test("the fee is labeled by product, region and date, with Link stablecoins listed apart (finding 2)", () => {
  const text = readStudy();
  for (const line of linesWith(text, "1.5%")) {
    assert.match(line, /\bUS\b|United States/, `1.5% without its region: ${line}`);
  }
  assert.match(text, /Link[^\n]{0,200}0\.8%[^\n]{0,200}2027-01-01[^\n]{0,200}0\.2%/);
  assert.match(text, /no Marktmorgen price or coefficient (?:is |was )?changed/i);
  assert.doesNotMatch(text, /\*\*1\.5% of the transaction amount in USD\*\*/);
  assert.doesNotMatch(text, /So the 1\.5% falls on the creator, not on Marktmorgen/);
});

test("a creator-paid processing fee does not make Marktmorgen's other costs zero (finding 3)", () => {
  const text = readStudy();
  // Changed (rule 23, Claude 5 on #2922): the cited source is matched as a parsed URL (host docs.stripe.com, exact path),
  // not as a substring of the study, which CodeQL flagged as incomplete URL sanitization; it holds the same citation.
  assert.ok(cites(text, "docs.stripe.com", "/connect/direct-charges-fee-payer-behavior"), "S21: Stripe's fee payer behavior for direct charges is cited");
  assert.match(text, /fee payer[\s\S]{0,400}does not prove/i);
  assert.match(text, /unimplemented hypothes[ie]s/i);
  assert.ok(text.includes("not an MR admission"), "not an MR admission");
  assert.match(text, /Unknown remains unknown/);
  assert.doesNotMatch(text, /\*\*Today: zero\.\*\*/);
  assert.doesNotMatch(text, /zero new Stripe calls per checkout and zero new storage/);
  assert.doesNotMatch(text, /no Marktmorgen margin line moves/);
});

test("the Stripe Tax unknown reflects the Checkout guide and keeps the real unknowns (finding 4)", () => {
  const text = readStudy();
  assert.match(text, /amount, currency, product details(?:,)? and customer location/);
  assert.match(text, /card or stablecoin payments/);
  assert.match(text, /no separate stablecoin(?:-specific)? Stripe Tax configuration/i);
  assert.doesNotMatch(text, /Nothing read says the payment method changes the tax calculation/);
  assert.doesNotMatch(text, /Whether Stripe Tax behaves identically for this payment method\./);
  // Provider documentation is not proof for an account, an integration, the law or the gates.
  assert.match(text, /Stripe Tax[^\n]*not confirmed[^\n]*(?:account|integration)/i);
  assert.match(text, /deemed-supplier gate/);
});
