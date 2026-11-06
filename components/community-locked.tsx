import Link from "next/link";
import type { LockedSpace } from "@/lib/community-locked";
import { lockedWords } from "@/lib/buyer-words/community-locked";

/**
 * A member's locked spaces (542 [CM1]): each one's name, its one line, the
 * word "Locked" in text beside a lock drawn only for the eye, and the way in.
 * It is given nothing else about a space (lib/community-locked.ts), so it
 * cannot show what is inside: no posts, no members, no counts, no address.
 */
export function LockedSpaces({ spaces, language }: { spaces: LockedSpace[]; language: unknown }) {
  if (spaces.length === 0) return null;
  const w = lockedWords(language);
  return (
    <section id="cm-locked" aria-labelledby="cm-locked-title" className="mb-6">
      <h2 id="cm-locked-title" className="text-lg font-semibold tracking-[-0.02em]">{w.heading}</h2>
      <p className="st-muted mt-1 text-sm">{w.intro}</p>
      <ul className="mt-3 space-y-3">
        {spaces.map((space, i) => (
          <li key={i} className="st-note">
            <h3 className="font-bold" style={{ color: "var(--st-text)" }}>
              <span className="break-words">{space.name}</span>
            </h3>
            {space.about ? <p className="mt-1 break-words text-sm">{space.about}</p> : null}
            <p className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: "var(--st-text)" }}>
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              <span>{w.locked}</span>
            </p>
            {typeof space.unlock === "object" ? (
              <p className="mt-3">
                <Link href={space.unlock.href} className="cm-pill">
                  {w.unlockWith(space.unlock.title)}
                  <span className="sr-only">{w.forSpace(space.name)}</span>
                </Link>
              </p>
            ) : (
              <p className="mt-2 text-sm">{space.unlock === "none" ? w.notYet : w.unknown}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
