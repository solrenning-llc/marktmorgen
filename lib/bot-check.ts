import { checkBotId } from "botid/server";

/**
 * Whether the request came from a program rather than a person's browser.
 *
 * A form that emails whatever address is typed into it is a way to send mail
 * to strangers: programs type other people's addresses into thousands of such
 * forms to bury an inbox, and every one of those emails is one its reader
 * never asked for, sent in our name. The honeypot and the limits per machine
 * and per address (lib/auth.ts) do not stop a program that drives a real
 * browser from many machines, one address each.
 *
 * So the page that holds the form (components/signin-form.tsx) answers a
 * challenge from the host as the request is sent, and the host is asked here
 * whether the answer holds (Vercel BotID, at its basic level: nothing to pay
 * per check, nothing shown to the person, no key of ours to keep).
 *
 * The check may only ever refuse a program. If the host does not answer in
 * time, or this is not running on the host at all (a local run, the tests),
 * the request is let through: the limits still bound it, and nobody is locked
 * out of their account because a service of somebody else's was slow.
 */
const ANSWER_WITHIN_MS = 2_500;

export async function isAutomated(): Promise<boolean> {
  if (process.env.VERCEL !== "1") return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ANSWER_WITHIN_MS);
    });
    const verdict = await Promise.race([checkBotId(), late]);
    if (!verdict) {
      console.error("bot check did not answer in time; the request was let through");
      return false;
    }
    return verdict.isBot === true;
  } catch (error) {
    console.error("bot check failed; the request was let through", error);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What the host's check says of the browser that sent this request, for a
 * count that a program must never be able to spend: a store's visits
 * (app/api/store/hit). Unlike isAutomated, which may only ever refuse a
 * program and so lets a request through on any doubt, this one counts only
 * on a clear yes:
 *
 *   - "human": the host's check answered, in its own shape, that a person's
 *     browser sent it;
 *   - "automated": it answered that a program did;
 *   - "unknown": it failed, did not answer within ANSWER_WITHIN_MS, or
 *     answered in another shape (CX-123 rule 24): never read as a person.
 *
 * Off the host (a local run, the tests) there is no check at all, and the
 * answer is "human", as every count was before the check existed.
 */
export type BrowserProof = "human" | "automated" | "unknown";

export async function browserProof(): Promise<BrowserProof> {
  if (process.env.VERCEL !== "1") return "human";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ANSWER_WITHIN_MS);
    });
    const verdict: unknown = await Promise.race([checkBotId(), late]);
    if (!verdict || typeof verdict !== "object") return "unknown";
    const isBot = (verdict as { isBot?: unknown }).isBot;
    if (typeof isBot !== "boolean") return "unknown";
    return isBot ? "automated" : "human";
  } catch {
    return "unknown";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
