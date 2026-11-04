/**
 * What the studio's key panel needs to know about API keys, with nothing that
 * runs on the server: the panel runs in the browser, and lib/api-keys.ts
 * imports the crypto and the database.
 */
export const MAX_KEYS = 5;
export const MAX_KEY_NAME = 40;
/** How a key starts, so one pasted into the wrong place is recognisable for what it is. */
export const KEY_PREFIX = "nl_live_";

export type ApiKey = {
  id: string;
  name: string;
  /** The first characters after the prefix, so the creator can tell keys apart. */
  hint: string;
  madeAt: number;
  /** Seconds; 0 when never used. */
  usedAt: number;
  /**
   * Whether it may also change the store (added 12 October 2026): add people
   * to the list, change their labels, give and take back products. Chosen
   * when the key is made and never changed after, so a key made to read
   * stays one that reads.
   */
  write: boolean;
  /**
   * What an AI agent holding it may prepare for the creator to confirm (631
   * [AA1] (c), added 2 November 2026): "none" (every key before then, and a
   * key made only to read or write), "draft" (changes the creator may confirm
   * in a batch) or "execute" (also changes confirmed one at a time: emails,
   * answers to buyers). Nothing is ever carried out on the key alone: the
   * agent prepares, the creator confirms (lib/agent-proposal-rules.ts).
   * Separate from `write`, and chosen when the key is made, like it.
   */
  agent: AgentScope;
};

/** What an AI agent's key may prepare: nothing, drafts, or drafts and execute changes. */
export type AgentScope = "none" | "draft" | "execute";
export const AGENT_SCOPES: readonly AgentScope[] = ["none", "draft", "execute"];

/** Whether a key of `scope` may prepare a change of `need`: an execute key also prepares drafts. */
export const agentMay = (scope: AgentScope, need: "draft" | "execute"): boolean =>
  need === "draft" ? scope === "draft" || scope === "execute" : scope === "execute";

/** A stored or sent value as a scope; anything else is "none". */
export const agentScopeOf = (raw: unknown): AgentScope => (raw === "draft" || raw === "execute" ? raw : "none");

/**
 * A key as the studio's panel shows it, with what the team's two-step rule
 * did to it (owner C3-100, 4 November 2026): whether it is paused, who made
 * it in words, and whether the person looking may turn it back on.
 */
export type ShownKey = ApiKey & {
  /** Paused by the team's two-step rule: every request with it is refused until it is turned back on. Never deleted. */
  paused: boolean;
  /** Who made it, in words: "you", "the owner", a teammate's address, or that it is not known. */
  maker: string;
  /** Whether the person looking may turn it back on (with a second step, in the route). */
  mayTurnOn: boolean;
  /** Whether the person looking may revoke it: a key whose maker left the team is the owner's alone to revoke. */
  mayRevoke: boolean;
  /** Why it is paused (lib/api-keys.ts PauseWhy), or null. */
  why: "rule" | "left" | "unmatched" | "role" | "unrecorded" | null;
};

/**
 * What the owner is told before turning a paused key back on (WCAG 3.3.6):
 * it works again at once, and, turned on with a second step, no later
 * two-step rule pauses it again; one paused for its maker's role works as it
 * did, whatever that role is now.
 */
export function turnOnNote(key: Pick<ShownKey, "why">): string {
  const base = "It works again at once, and the team's two-step rule will not pause it again.";
  if (key.why === "role") return "It works again at once, whatever their role and the team's two-step rule, until the person who made it leaves the team. Their role does not allow such a key, so turn it on only if you want it to keep working for them.";
  if (key.why === "unrecorded") return `${base} Nobody is recorded as its maker, so turn it on only if you know it is yours or one you trust.`;
  if (key.why === "unmatched") return "It works again at once, whatever the team's two-step rule, until the person who made it leaves the team. Its maker could not be matched to anyone on the team, so turn it on only if you know whose it is.";
  return base;
}

/** The words for a key whose maker was never recorded: every key made before 4 November 2026. */
export const MAKER_UNRECORDED = "someone not recorded";
/** The words for a key whose maker's fingerprint matches nobody on the team now. */
export const MAKER_UNMATCHED = "someone who could not be matched to the team";
/** The words for a key whose maker is no longer on the team. */
export const MAKER_FORMER = "someone no longer on the team";

/** One line of the review before the team's two-step switch is saved: whose keys, how many, the webhook endpoints they added, and whether they will be emailed. */
export type PauseLine = { who: string; count: number; endpoints: number; emailed: boolean };
/**
 * The API keys, and the webhook endpoints they added, that will pause when
 * the team's two-step switch is turned on (lib/api-key-pause.ts
 * pausePreview); `untold`, keys paused before whose makers still wait for
 * their email; `stamp`, made from exactly which ids, sent back with the save.
 */
export type PausePreview = { total: number; endpoints: number; untold: number; stamp: string; people: PauseLine[] };

/** Why a paused key is paused and who can turn it back on, in the words of the key panel, by why (lib/api-keys.ts PauseWhy). */
export function pausedWords(key: Pick<ShownKey, "why" | "mayTurnOn">): string {
  const stopped = "Anything using it is refused, and the webhook endpoints it added are sent nothing";
  const until = key.mayTurnOn ? "until you turn it back on" : "until the store's owner turns it back on";
  if (key.why === "left") return `Whoever made it is no longer on the team. ${stopped}. It can only be revoked, by the store's owner.`;
  if (key.why === "role") return `The role of whoever made it no longer allows such a key. ${stopped}, ${until}.`;
  if (key.why === "unmatched") return `The person who made it could not be matched to anyone on the team. ${stopped}, ${until}.`;
  if (key.why === "unrecorded") return `Someone on the team left or lost access to keys, and nobody is recorded as this key's maker, so it may have been theirs. ${stopped}, ${until}.`;
  return `The team now logs in with a second step, and this key was made without one. ${stopped}, ${key.mayTurnOn ? "until you turn it back on" : "until whoever made it turns it back on"}.`;
}
