/**
 * A ready set of spaces for a new community (487 [IT4], item 5: no empty
 * screen without a ready example; added 2 November 2026). A community starts
 * with one space, General (components/community-studio.tsx). While that is
 * still all it has, the studio offers the three spaces most communities start
 * with, each with one line saying what goes there. They are added with the
 * studio's own "Add a space" action, open to every member, and each can be
 * renamed, moved or removed like any other. Nothing in them is a claim or a
 * figure: they say what goes where.
 */
import { MAX_SPACE_ABOUT, MAX_SPACE_NAME, MAX_SPACES } from "@/lib/community-text";

export type StarterSpace = { name: string; about: string };

export const STARTER_SPACES: StarterSpace[] = [
  { name: "Introductions", about: "Say hello: who you are and what brought you here." },
  { name: "Questions", about: "Ask the community anything." },
  { name: "Wins", about: "Share what worked, big or small." },
];

/**
 * The ready spaces to offer: only while the community has a single space, and
 * only those whose name it does not already use (in any case), within the
 * most spaces a community may have. Empty when there is nothing to offer.
 */
export function startersToAdd(spaces: readonly { name: string }[]): StarterSpace[] {
  if (spaces.length !== 1) return [];
  const taken = new Set(spaces.map((s) => s.name.trim().toLowerCase()));
  return STARTER_SPACES.filter((s) => !taken.has(s.name.toLowerCase()) && s.name.length <= MAX_SPACE_NAME && s.about.length <= MAX_SPACE_ABOUT).slice(0, MAX_SPACES - spaces.length);
}

/** What the studio says once they are added. */
export function startersAddedWords(count: number): string {
  const said = ["No space", "One space", "Two spaces", "Three spaces"][count] ?? `${count} spaces`;
  return `${said} added. Rename, move or remove any of them in the Spaces list.`;
}
