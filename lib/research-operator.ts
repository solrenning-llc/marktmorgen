/**
 * Whether a request, or a page's cookies, comes from the person who runs the
 * site, for the operator's tools of the research do-not-contact list
 * (app/api/operator/do-not-contact and its check, /privacy/do-not-contact).
 * Nothing is read unless an operator is configured and a session cookie was
 * sent; the session must be the operator's (isOperator, as
 * app/api/operator/search-console) and not locked (lockedFor, as the
 * "settings" a locked session waits to change after a two-step reset, which
 * the sign-in history's note names). A read that fails, or a lock it cannot
 * read, lets nobody in.
 */
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { configuredDemoStudioAdmin } from "@/lib/house-store";
import { isOperator } from "@/lib/search-console";
import { lockedFor } from "@/lib/two-step";

type CookieSource = { get(name: string): { value: string } | undefined };

export async function researchOperator(cookies: CookieSource): Promise<boolean> {
  if (!configuredDemoStudioAdmin()) return false;
  const session = cookies.get(SESSION_COOKIE)?.value ?? "";
  if (!session) return false;
  const email = await emailForSession(session).catch(() => null);
  if (!isOperator(email)) return false;
  return !(await lockedFor({ cookies }, "settings", "").catch(() => true));
}
