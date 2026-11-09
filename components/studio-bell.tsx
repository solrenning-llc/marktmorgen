// RED stub (766 [STN13], unit 4): replaced by the real panel in the next commit.
import type { Role } from "@/lib/team-roles";
import type { BellFacts } from "@/lib/bell-rules";
export function StudioBell({ store, role, now }: { store: { sid: string } & BellFacts; role: Role; now?: number }) {
  void store;
  void role;
  void now;
  return null;
}
