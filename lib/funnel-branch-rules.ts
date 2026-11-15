/**
 * A funnel's "Conditional path" step (526 [FN2], unit 5): rules only. Pure
 * and browser-safe.
 *
 * A branch sends each visitor to one of the store's own pages or products by
 * what the visit itself already says, never by anything kept about the
 * person: 1 to 4 rules in order, the first that matches wins, and a default
 * page for whoever matches none.
 *
 *   - "bought" / "declined": the visitor bought, or said "No thanks" to, the
 *     paid product step just before the branch. Known only at that moment:
 *     the thank-you page knows the order was paid, the product page's
 *     "No thanks, continue" link knows it was not. Anywhere else it is not
 *     known, and an unknown never matches.
 *   - "source" / "campaign": the utm_source or utm_campaign tag on the
 *     address equals the creator's word, cleaned the way the store counts
 *     tags (lib/came-from.ts).
 *   - "phone" / "computer": from the browser's own name (the User-Agent
 *     header), read for this request only and never kept.
 *
 * The conditions of email sequences (lib/flow-rules.ts) are about a person on
 * the creator's list, read from what the list keeps about them; a funnel's
 * visitor is nobody on a list, so none of those conditions can be read here,
 * and none of them is copied.
 */
import { cleanCampaignTag, cleanSourceTag } from "@/lib/came-from";

export const BRANCH_MIN_RULES = 1;
export const BRANCH_MAX_RULES = 4;
/** The same id shape as a funnel step's (lib/page-funnel.ts). */
const STEP_ID = /^[A-Za-z0-9_-]{1,40}$/;

export type BranchPlace = { kind: "page" | "product"; id: string };
export type BranchIf = "bought" | "declined" | "source" | "campaign" | "phone" | "computer";
export const BRANCH_IFS: readonly BranchIf[] = ["bought", "declined", "source", "campaign", "phone", "computer"];
export type BranchRule =
  | { if: "bought" | "declined" | "phone" | "computer"; to: BranchPlace }
  | { if: "source" | "campaign"; value: string; to: BranchPlace };
export type FunnelBranch = { kind: "branch"; rules: BranchRule[]; otherwise: BranchPlace };

/** What is known about one visit; a field left out is not known. */
export type VisitFacts = { bought?: boolean; source?: string; campaign?: string; device?: "phone" | "computer" };

/** Whether a rule reads the offer just before the branch. */
export const readsOffer = (rule: Pick<BranchRule, "if">) => rule.if === "bought" || rule.if === "declined";
/** Whether a rule reads a tag on the address. */
export const readsTag = (rule: Pick<BranchRule, "if">) => rule.if === "source" || rule.if === "campaign";

/** The word a tag rule compares with, cleaned the way the store counts that tag. */
export const cleanBranchValue = (kind: "source" | "campaign", raw: unknown) =>
  typeof raw === "string" ? (kind === "source" ? cleanSourceTag(raw) : cleanCampaignTag(raw)) : "";

function readPlace(raw: unknown): BranchPlace | null {
  if (!raw || typeof raw !== "object") return null;
  const { kind, id } = raw as { kind?: unknown; id?: unknown };
  return (kind === "page" || kind === "product") && typeof id === "string" && STEP_ID.test(id) ? { kind, id } : null;
}

/** A branch as saved or sent, or null for anything that is not a whole, valid one. */
export function parseBranch(raw: unknown): FunnelBranch | null {
  if (!raw || typeof raw !== "object") return null;
  const { rules, otherwise } = raw as { rules?: unknown; otherwise?: unknown };
  if (!Array.isArray(rules) || rules.length < BRANCH_MIN_RULES || rules.length > BRANCH_MAX_RULES) return null;
  const fallback = readPlace(otherwise);
  if (!fallback) return null;
  const read: BranchRule[] = [];
  for (const entry of rules) {
    if (!entry || typeof entry !== "object") return null;
    const value = entry as { if?: unknown; value?: unknown; to?: unknown };
    const kind = BRANCH_IFS.find((k) => k === value.if);
    const to = readPlace(value.to);
    if (!kind || !to) return null;
    if (kind === "source" || kind === "campaign") {
      const word = cleanBranchValue(kind, value.value);
      if (!word) return null;
      read.push({ if: kind, value: word, to });
    } else read.push({ if: kind, to });
  }
  // Each page once inside a branch, as across the whole funnel.
  const keys = [...read.map((rule) => rule.to), fallback].map((place) => `${place.kind}:${place.id}`);
  if (new Set(keys).size !== keys.length) return null;
  return { kind: "branch", rules: read, otherwise: fallback };
}

/** Whether a rule holds for this visit. Something not known never holds. */
export function ruleHolds(rule: BranchRule, facts: VisitFacts): boolean {
  switch (rule.if) {
    case "bought":
      return facts.bought === true;
    case "declined":
      return facts.bought === false;
    case "source":
      return Boolean(facts.source) && cleanSourceTag(facts.source ?? "") === rule.value;
    case "campaign":
      return Boolean(facts.campaign) && cleanCampaignTag(facts.campaign ?? "") === rule.value;
    case "phone":
    case "computer":
      return facts.device === rule.if;
  }
}

/**
 * Where a branch sends this visit: the first matching rule whose page can be
 * shown now, else the default when it can, else null (the funnel passes the
 * step over, as it passes over any step it cannot show).
 */
export function branchPick(branch: Pick<FunnelBranch, "rules" | "otherwise">, facts: VisitFacts, open: (place: BranchPlace) => boolean): BranchPlace | null {
  for (const rule of branch.rules) if (ruleHolds(rule, facts) && open(rule.to)) return rule.to;
  return open(branch.otherwise) ? branch.otherwise : null;
}

/** A phone or a computer, from the browser's own name only; no name, not known. Tablets count as computers. */
export function visitDevice(userAgent: string | null | undefined): "phone" | "computer" | undefined {
  if (!userAgent || !userAgent.trim()) return undefined;
  return /\b(iPhone|iPod|Windows Phone|BlackBerry|Opera Mini|IEMobile)\b|Android.*\bMobile\b|\bMobi/i.test(userAgent) ? "phone" : "computer";
}

/** What a visit's own address and browser say: its tags and its device. Nothing is kept. */
export function visitFacts(params: { get(name: string): string | null } | null, userAgent: string | null | undefined): VisitFacts {
  const source = params ? cleanSourceTag(params.get("utm_source")) : "";
  const campaign = params ? cleanCampaignTag(params.get("utm_campaign")) : "";
  const device = visitDevice(userAgent);
  return { ...(source ? { source } : {}), ...(campaign ? { campaign } : {}), ...(device ? { device } : {}) };
}

/** A page's query, as Next.js hands it over, read like an address's search part. */
export const queryReader = (query: Record<string, string | string[] | undefined>) => ({
  get: (name: string) => {
    const value = query[name];
    return typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
  },
});

/** A rule's condition in plain words, as the studio says it. */
export function branchIfWords(rule: Pick<BranchRule, "if"> & { value?: string }): string {
  switch (rule.if) {
    case "bought":
      return "they bought the offer just before";
    case "declined":
      return "they said no to the offer just before";
    case "source":
      return `the link's source tag is "${rule.value ?? ""}"`;
    case "campaign":
      return `the link's campaign tag is "${rule.value ?? ""}"`;
    case "phone":
      return "they are on a phone";
    case "computer":
      return "they are on a computer or tablet";
  }
}
