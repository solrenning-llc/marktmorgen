/**
 * Whose a Stripe reply about a checkout session is (Claude 5's find while reviewing #4455; rule 24). An answer is
 * about the session asked for only when it names it: a reply with another id, or none, says nothing about this one
 * (a cached or misrouted answer, a proxy's, another account's), and nothing held for this session is let go on it.
 */
export function ownSessionReply(reply: unknown, session: string): Record<string, unknown> | null {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return null;
  const record = reply as Record<string, unknown>;
  return typeof record.id === "string" && record.id === session ? record : null;
}

/** True only for this session's own "expired": a hold may then be let go, because Stripe can no longer take its payment. */
export function expiredFor(reply: unknown, session: string): boolean {
  return ownSessionReply(reply, session)?.status === "expired";
}
