/**
 * The published limits of a store's list.
 *
 * They live apart from lib/contacts.ts because that file opens a Redis
 * connection and hashes addresses, and a marketing page that cannot import
 * the real number ends up retyping it — which is how a site starts
 * advertising a limit the code does not hold. Nothing here reads an
 * environment variable or a secret, so a client component may import it.
 */

/** How many addresses one store's list may hold, on either plan. */
export const MAX_LEADS = 100_000;

/** How many addresses one paste-import may bring at a time. */
export const MAX_IMPORT = 5_000;

/** "100,000", for a sentence. */
export function listSizeWords(): string {
  return MAX_LEADS.toLocaleString("en-US");
}

/** How long a name kept for a contact may be, and how many labels of what length. */
export const MAX_CONTACT_NAME = 100;
export const MAX_CONTACT_TAGS = 10;
export const MAX_TAG_LENGTH = 40;

/** Labels as a file writes them — "vip, buyers" or "vip;buyers" — cleaned and kept once each. */
export function readTags(raw: string | string[]): string[] {
  const pieces = Array.isArray(raw) ? raw : raw.split(/[,;|]/);
  const out: string[] = [];
  for (const piece of pieces) {
    // Cut, then trimmed, so a label read again comes out the same (99 [E2-TAG-BROADCAST]: an email keeps one).
    const tag = String(piece).replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH).trim();
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= MAX_CONTACT_TAGS) break;
  }
  return out;
}
