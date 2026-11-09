// RED stub (766 [STN13], unit 4): replaced by the real rules in the next commit.
import type { Role } from "@/lib/team-roles";
export type BellFacts = Record<string, unknown>;
export type BellItem = { id: string; words: string; link: { href: string; label: string } | null };
export type BellView = { needs: BellItem[]; news: BellItem[] };
export const MOST_NEWS = 0;
export function bellView(store: { sid: string } & BellFacts, role: Role, nowMs: number): BellView {
  void store;
  void role;
  void nowMs;
  return { needs: [], news: [] };
}
