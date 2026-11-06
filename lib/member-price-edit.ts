/**
 * The studio's editor for member and past-buyer prices (620 [SZ4], unit 3;
 * the rules are in lib/member-price-rules.ts).
 *
 * One check for the browser and the server (app/api/store/member-price):
 * what is saved is exactly what was sent, or nothing. A rule that the
 * store's reader would quietly trim (lib/member-price-rules.ts,
 * parseMemberPrices) is refused here instead, naming the field to fix, so
 * the creator never saves something other than what they reviewed.
 *
 * These are the creator's own prices for their own products, taken off on
 * their own Stripe account: nothing here touches Marktmorgen's prices.
 *
 * Browser-safe.
 */
import { formatMoney } from "./money";
import {
  MAX_MEMBER_PRODUCTS,
  MAX_MEMBER_QUALIFYING,
  MAX_MEMBER_RULES,
  type MemberPrices,
  type MemberRule,
  isMemberPercent,
  parseMemberPrices,
} from "./member-price-rules";

/** A product whose holder can qualify: paid, sold now, not a call. */
export type MemberChoice = { id: string; title: string; membership: boolean };
/** A product a rule can lower: what a sale could cover, at its price. */
export type MemberDiscounted = { id: string; title: string; priceCents: number };
export type MemberEditChoices = { qualifying: MemberChoice[]; discounted: MemberDiscounted[] };

/** Which part of the form a refusal is about. */
export type MemberEditField = "form" | "on" | "rules" | "by" | "percent" | "products";
export type MemberEditRefusal = { ok: false; error: string; field: MemberEditField; rule: number | null; message: string };

/** What each refusal tells the creator, naming the part of the form to fix. */
export const MEMBER_EDIT_MESSAGES: Record<string, string> = {
  invalid: "The form sent something this page does not expect. Reload the page and try again.",
  unknown: "The form sent a field this page does not have. Reload the page and try again.",
  rules_none: "Add at least one rule before you switch member prices on.",
  rules_many: `You can have up to ${MAX_MEMBER_RULES} rules. Remove one to add another.`,
  rule: "One rule is not set up the right way. Check its products, or remove the rule and add it again.",
  percent: "Under \"How much less\", choose from 5% to 90%, in steps of 5.",
  qualifying: "Under \"Who pays less\", choose at least one product your store sells now.",
  qualifying_many: `Across all your rules, up to ${MAX_MEMBER_QUALIFYING} products under "Who pays less" can give a lower price. Remove some to save.`,
  products: `Under "Which products cost less", choose from 1 to ${MAX_MEMBER_PRODUCTS} products sold once at one price.`,
  same: "A product can't lower its own price. Under \"Which products cost less\", remove the product that is also under \"Who pays less\".",
  stripe: "Connect your Stripe account first. Member prices are taken off on your Stripe checkout.",
};

const RULE_KEYS = ["id", "percent", "by", "all", "products"];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function refuse(error: string, field: MemberEditField, rule: number | null = null): MemberEditRefusal {
  return { ok: false, error, field, rule, message: MEMBER_EDIT_MESSAGES[error] ?? MEMBER_EDIT_MESSAGES.invalid };
}

const plain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const idList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string" && ID.test(v));
const once = (list: string[]) => new Set(list).size === list.length;

/**
 * The edit as sent, checked against what the store sells now: the setting to
 * save, or the first thing to fix. `connected`: whether the store's Stripe
 * account is connected (needed to switch it on).
 */
export function checkMemberEdit(raw: unknown, choices: MemberEditChoices, connected: boolean): { ok: true; value: MemberPrices } | MemberEditRefusal {
  if (!plain(raw)) return refuse("invalid", "form");
  if (Object.keys(raw).some((key) => key !== "on" && key !== "rules")) return refuse("unknown", "form");
  if (typeof raw.on !== "boolean") return refuse("invalid", "on");
  if (!Array.isArray(raw.rules)) return refuse("invalid", "rules");
  const on = raw.on;
  const sent: unknown[] = raw.rules;
  if (sent.length > MAX_MEMBER_RULES) return refuse("rules_many", "rules");
  if (on && sent.length === 0) return refuse("rules_none", "rules");

  // First the shape of every rule, then the sizes across them, then what the store sells.
  const rules: MemberRule[] = [];
  const names = new Set<string>();
  for (const [i, item] of sent.entries()) {
    if (!plain(item)) return refuse("rule", "rules", i);
    if (Object.keys(item).some((key) => !RULE_KEYS.includes(key))) return refuse("unknown", "rules", i);
    if (typeof item.id !== "string" || !ID.test(item.id) || names.has(item.id) || typeof item.all !== "boolean") return refuse("rule", "rules", i);
    if (typeof item.percent !== "number" || !isMemberPercent(item.percent)) return refuse("percent", "percent", i);
    if (!idList(item.by) || item.by.length === 0 || !once(item.by)) return refuse("qualifying", "by", i);
    if (!idList(item.products)) return refuse("products", "products", i);
    names.add(item.id);
    rules.push({ id: item.id, percent: item.percent, by: [...item.by], all: item.all, products: [...item.products] });
  }
  if (new Set(rules.flatMap((rule) => rule.by)).size > MAX_MEMBER_QUALIFYING) return refuse("qualifying_many", "by");

  const qualifying = new Set(choices.qualifying.map((q) => q.id));
  const discounted = new Set(choices.discounted.map((d) => d.id));
  for (const [i, rule] of rules.entries()) {
    if (!rule.by.every((id) => qualifying.has(id))) return refuse("qualifying", "by", i);
    if (rule.all) {
      if (rule.products.length > 0) return refuse("rule", "rules", i);
      continue;
    }
    if (rule.products.length === 0 || rule.products.length > MAX_MEMBER_PRODUCTS || !once(rule.products)) return refuse("products", "products", i);
    if (!rule.products.every((id) => discounted.has(id))) return refuse("products", "products", i);
    if (rule.products.some((id) => rule.by.includes(id))) return refuse("same", "products", i);
  }
  if (on && !connected) return refuse("stripe", "on");

  const value: MemberPrices = { on, rules };
  // What the store's reader would keep must be exactly this; anything else is refused, never trimmed.
  const kept = parseMemberPrices(value);
  if (JSON.stringify(kept.rules) !== JSON.stringify(rules) || kept.on !== on) return refuse("rule", "rules");
  return { ok: true, value };
}

/** A price with this percentage off, as Stripe takes a percentage coupon off. */
function lowered(cents: number, percent: number): number {
  return cents - Math.round((cents * percent) / 100);
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function either(parts: string[]): string {
  return parts.join(" or ");
}

/** Products named in one review line before "and N more". */
const NAMED = 3;

/**
 * One rule in plain words, for the review before saving: who pays what
 * instead of what, on which products.
 */
export function memberRuleLine(rule: MemberRule, choices: MemberEditChoices, currency: string): string {
  const byId = new Map(choices.qualifying.map((q) => [q.id, q]));
  const held = rule.by.map((id) => byId.get(id)).filter((q): q is MemberChoice => Boolean(q));
  const members = held.filter((q) => q.membership).map((q) => q.title);
  const buyers = held.filter((q) => !q.membership).map((q) => q.title);
  const who = [members.length ? `members of ${either(members)}` : "", buyers.length ? `buyers of ${either(buyers)}` : ""].filter(Boolean).join(" or ") || "nobody";
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  const price = (d: MemberDiscounted) => `${formatMoney(lowered(d.priceCents, rule.percent), currency)} instead of ${formatMoney(d.priceCents, currency)} for ${d.title}`;

  if (rule.all) {
    const example = choices.discounted.find((d) => !rule.by.includes(d.id));
    const start = `${Who} will pay ${rule.percent}% less on every product a sale can cover, now and added later.`;
    return example ? `${start} For example, ${price(example)}.` : `${start} None of your products can have it yet: add one sold once at one price.`;
  }
  const byProduct = new Map(choices.discounted.map((d) => [d.id, d]));
  const lowerOn = rule.products.map((id) => byProduct.get(id)).filter((d): d is MemberDiscounted => Boolean(d));
  const named = lowerOn.slice(0, NAMED).map(price);
  const more = lowerOn.length - named.length;
  return `${Who} will pay ${list(more > 0 ? [...named, `${more} more ${more === 1 ? "product" : "products"} at ${rule.percent}% less`] : named)}.`;
}
