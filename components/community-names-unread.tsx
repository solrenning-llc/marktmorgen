import { communityNamesUnreadWords } from "@/lib/buyer-words/community-names-unread";

/**
 * Said where a community page could not read who its members are (rules 24 and 30): the names it draws as
 * "A member" in their place, the members list or the members search. A status, in words, never shown only by color.
 */
export function NamesUnread({ language, what = "names", className = "" }: { language: unknown; what?: "names" | "membersList" | "membersSearch"; className?: string }) {
  return (
    <p className={`cm-flash cm-flash-warn ${className}`} role="status">
      {communityNamesUnreadWords(language)[what]}
    </p>
  );
}
