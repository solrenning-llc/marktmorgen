import { emailForSession } from "@/lib/auth";
import type { Store } from "@/lib/store";
import { roleIn, teamTwoStepBlocks } from "@/lib/team";

/**
 * Whether the person whose session this is may see a store's drafts
 * (lib/catalog.ts, `hidden`) at a public address: the store's owner, or
 * someone on its team, signed in, as the studio would let them into this
 * store (lib/studio-route.ts, resolveAccess with the store pinned: their
 * role in it, and the team's two-step rule read from this session). The
 * store already read is the one asked about, so it is not read again.
 *
 * A draft is left off the store, its own page and its checkout, so its
 * title, price, outline, preview lessons and sample certificate are never
 * shown to whoever only knows its id (MM-SA-30). Its students still reach
 * what they bought: that is read from their access, not from here.
 *
 * Anything not known is a no: no session, a session that cannot be read, or
 * a role or team that cannot be read.
 */
export async function seesDrafts(store: Store, session: string | undefined): Promise<boolean> {
  if (!session) return false;
  try {
    const email = await emailForSession(session);
    if (!email) return false;
    const role = await roleIn(store, email);
    if (!role) return false;
    return !(await teamTwoStepBlocks(store, email, role, session));
  } catch (error) {
    console.error("reading who may see a draft failed", error);
    return false;
  }
}
