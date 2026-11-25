import { endSession, openSession } from "@/lib/auth";
import { UnknownReplyError } from "@/lib/redis-reply";

/**
 * Opens a session only while what let it open without a second step still holds (#3947, #4032). The caller decided
 * before this call (no account yet, no two-step login), and that decision can go stale while it awaits: an app
 * turned on, or an account made, in another browser. So `still` is read again once the session exists. A change
 * written before that read is seen, and the session is taken back before anyone holds it (null); a change written
 * after it found the session already open, exactly like any session opened before the change, which turning on an
 * app leaves as it is (lib/two-step.ts finishSetup). Re-reading before opening would leave the window open. A
 * reading that throws, or a take-back that is not confirmed, throws (CX-123 rule 24): never a session given out.
 */
export async function openSessionWhile(email: string, still: () => Promise<boolean>): Promise<string | null> {
  const id = await openSession(email);
  let holds = false;
  try {
    holds = await still();
  } catch (error) {
    await endSession(id);
    throw error;
  }
  if (holds) return id;
  if (!(await endSession(id))) throw new UnknownReplyError("taking back a session opened too late");
  return null;
}
