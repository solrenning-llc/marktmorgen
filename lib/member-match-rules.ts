/**
 * Members with interests in common, the rules only (424 [MN1], unit 1; added
 * 12 November 2026). Pure and browser-safe; the creator's switch, the
 * member's choice in their profile and the list on the page are later units,
 * and none of it is on yet.
 *
 *   - Asked for on both sides: the creator may offer it to the community, and
 *     each member is out until they themselves join and pick interests.
 *     Being listed in the directory is not joining.
 *   - A closed list of interests, chosen by the member from it: never typed
 *     words, never guessed from what someone bought, read or wrote, and no
 *     interest that tells health, religion, politics, sex life, origin,
 *     age or anything else sensitive about a person (MN1's own list).
 *   - Only other joined members of the same community, with access now, not
 *     removed and not muted; a block either way removes the pair, and the
 *     list never says that someone was left out or why.
 *   - Explainable: each suggestion says the interests the two share, and no
 *     other interest of the other person. No score, no "match", nothing paid
 *     or by plan moves anyone up; ties go by an order that differs for each
 *     reader but is the same each time, so the same few are not always first.
 *   - Empty and unknown are different: a verdict that could not be read
 *     leaves that member out, and when that leaves nothing, the answer is
 *     "unknown", never "nobody shares your interests".
 *   - Bounded: at most MAX_CANDIDATES members are looked at per reading and
 *     MAX_SUGGESTIONS are shown; no AI, no reading outside the community.
 *
 * Nothing is sent to anyone: a suggestion only offers the reader the
 * existing direct message, under its own rules (lib/community-dm.ts).
 */

/** The interests a member may choose from: neutral topics of making and selling online. */
export const INTERESTS = [
  { id: "writing", label: "Writing" },
  { id: "newsletters", label: "Newsletters" },
  { id: "blogging", label: "Blogging" },
  { id: "video", label: "Video" },
  { id: "podcasting", label: "Podcasting" },
  { id: "livestreaming", label: "Live streaming" },
  { id: "photography", label: "Photography" },
  { id: "illustration", label: "Illustration" },
  { id: "graphic-design", label: "Graphic design" },
  { id: "music", label: "Music" },
  { id: "crafts", label: "Crafts and making" },
  { id: "cooking", label: "Cooking" },
  { id: "travel", label: "Travel" },
  { id: "gaming", label: "Gaming" },
  { id: "books", label: "Books" },
  { id: "languages", label: "Learning languages" },
  { id: "teaching", label: "Teaching" },
  { id: "online-courses", label: "Online courses" },
  { id: "coaching", label: "Coaching" },
  { id: "community-building", label: "Building a community" },
  { id: "social-media", label: "Social media" },
  { id: "email-marketing", label: "Email marketing" },
  { id: "seo", label: "Search (SEO)" },
  { id: "ads", label: "Ads" },
  { id: "sales-pages", label: "Sales pages" },
  { id: "pricing", label: "Pricing" },
  { id: "digital-products", label: "Digital products" },
  { id: "physical-products", label: "Physical products" },
  { id: "memberships", label: "Memberships" },
  { id: "freelancing", label: "Freelancing" },
  { id: "productivity", label: "Productivity" },
  { id: "coding", label: "Coding" },
  { id: "no-code", label: "No-code tools" },
  { id: "ai-tools", label: "AI tools" },
  { id: "analytics", label: "Analytics" },
  { id: "branding", label: "Branding" },
] as const;

export type InterestId = (typeof INTERESTS)[number]["id"];

/** The most interests one member picks. */
export const MAX_INTERESTS = 8;
/** The most other members one reading looks at. */
export const MAX_CANDIDATES = 500;
/** The most suggestions shown at once. */
export const MAX_SUGGESTIONS = 5;

const KNOWN = new Map<string, string>(INTERESTS.map((i) => [i.id, i.label]));

/** An interest's words, or null for an id not on the list. */
export const interestLabel = (id: string): string | null => KNOWN.get(id) ?? null;

export type InterestsResult = { ok: true; interests: InterestId[] } | { ok: false; reason: "shape" | "unknown" | "many" };

/**
 * The interests a member sent, checked: a list of ids from the list, each once,
 * at most MAX_INTERESTS. Anything else is refused, never cut or guessed: an id
 * not on the list is not turned into the nearest one.
 */
export function cleanInterests(raw: unknown): InterestsResult {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) return { ok: false, reason: "shape" };
  const ids = [...new Set(raw as string[])];
  if (ids.some((id) => !KNOWN.has(id))) return { ok: false, reason: "unknown" };
  if (ids.length > MAX_INTERESTS) return { ok: false, reason: "many" };
  // In the list's own order, so the same choice is always stored the same way.
  return { ok: true, interests: INTERESTS.map((i) => i.id).filter((id) => ids.includes(id)) };
}

/** What the page says for each refusal, in plain words. */
export const INTEREST_PROBLEMS: Record<Exclude<InterestsResult, { ok: true }>["reason"], string> = {
  shape: "Pick your interests from the list.",
  unknown: "One of those is not on the list any more. Pick again from the list.",
  many: `Pick up to ${MAX_INTERESTS} interests.`,
};

export type MatchMember = {
  key: string;
  /** Joined "Suggest members who share my interests": false until they do. */
  joined: boolean;
  interests: readonly string[];
  removed: boolean;
  muted: boolean;
  /** Whether they hold access to the community now: true, false, or null when it could not be read. */
  access: boolean | null;
};

export type Suggestion = { key: string; shared: { id: string; label: string }[]; canMessage: boolean };

export type Suggestions =
  | { kind: "off" }
  | { kind: "not-joined" }
  | { kind: "list"; items: Suggestion[]; partial: boolean }
  | { kind: "empty" }
  | { kind: "unknown" };

// A small stable hash (FNV-1a), so ties go in an order of its own for each reader.
function order(a: string, b: string): number {
  let h = 0x811c9dc5;
  for (const c of `${a}\u0000${b}`) {
    h ^= c.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The members to suggest to `me`. `blocked(a, b)` says whether either has
 * blocked the other (true, false, or null when it could not be read);
 * `mayMessage(key)` whether the existing direct messages let `me` write to
 * them now. Only the interests the two share are given back.
 */
export function suggestFor(input: {
  offered: boolean;
  me: MatchMember;
  others: readonly MatchMember[];
  blocked: (a: string, b: string) => boolean | null;
  mayMessage: (key: string) => boolean;
}): Suggestions {
  const { me } = input;
  if (!input.offered) return { kind: "off" };
  if (!me.joined || me.removed || me.access === false) return { kind: "not-joined" };
  if (me.access === null) return { kind: "unknown" };
  const mine = new Set(me.interests.filter((id) => KNOWN.has(id)));
  if (!mine.size) return { kind: "not-joined" };
  let partial = input.others.length > MAX_CANDIDATES;
  const found: (Suggestion & { rank: number })[] = [];
  for (const other of input.others.slice(0, MAX_CANDIDATES)) {
    if (other.key === me.key || !other.joined || other.removed || other.muted) continue;
    const shared = [...new Set(other.interests)].filter((id) => mine.has(id));
    if (!shared.length) continue;
    const block = input.blocked(me.key, other.key);
    if (other.access === null || block === null) {
      partial = true;
      continue;
    }
    if (other.access !== true || block) continue;
    found.push({
      key: other.key,
      shared: INTERESTS.filter((i) => shared.includes(i.id)).map((i) => ({ id: i.id, label: i.label })),
      canMessage: input.mayMessage(other.key),
      rank: order(me.key, other.key),
    });
  }
  if (!found.length) return partial ? { kind: "unknown" } : { kind: "empty" };
  found.sort((x, y) => y.shared.length - x.shared.length || x.rank - y.rank || x.key.localeCompare(y.key));
  return { kind: "list", partial, items: found.slice(0, MAX_SUGGESTIONS).map(({ key, shared, canMessage }) => ({ key, shared, canMessage })) };
}

/** The line under a suggestion: "You both picked Video and Podcasting." */
export function sharedWords(shared: readonly { label: string }[]): string {
  const labels = shared.map((s) => s.label);
  const list = labels.length <= 2 ? labels.join(" and ") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `You both picked ${list}.`;
}
