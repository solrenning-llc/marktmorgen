"use client";

import { useState, useSyncExternalStore } from "react";
import type { MailMonthNotice } from "@/lib/mail-month-notice";

/*
 * The note in the email studio's "This month" card from 80% of the month's
 * list emails (357 [ES3], unit 1; lib/mail-month-notice.ts).
 *
 * A plain note, never a dialog: it takes no focus, opens nothing and moves
 * nowhere (WCAG 3.2.5). It can be hidden; the choice is kept in this browser
 * only, for this store, this month and this level, so it comes back once the
 * month is used up or a new month begins. Browser storage can be missing or
 * refused, so every read and write is inside try and the note simply shows.
 * Hiding hands focus to the card's heading, so a keyboard or screen reader
 * user is not left on nothing.
 */
const onStorage = (changed: () => void) => {
  window.addEventListener("storage", changed);
  return () => window.removeEventListener("storage", changed);
};

/** Whether this note was hidden in this browser before; no storage means it shows. */
function storedHidden(hideKey: string | null): boolean {
  if (!hideKey) return false;
  try {
    return window.localStorage.getItem(hideKey) === "1";
  } catch {
    return false;
  }
}

export function MailMonthNoticeBox({ notice, hideKey, headingId }: { notice: MailMonthNotice; hideKey: string | null; headingId: string }) {
  // The server cannot know this browser's choice, so it draws the note; the browser then reads it.
  const stored = useSyncExternalStore(onStorage, () => storedHidden(hideKey), () => false);
  const [hidden, setHidden] = useState(false);

  if (stored || hidden) return null;

  const hide = () => {
    if (hideKey) {
      try {
        window.localStorage.setItem(hideKey, "1");
      } catch {
        // No storage: hidden for this visit only.
      }
    }
    setHidden(true);
    document.getElementById(headingId)?.focus();
  };

  return (
    <div className={`notice ${notice.level === "out" ? "notice-warn" : "notice-info"} mt-4`} role="status" data-mail-month-notice={notice.level}>
      <p className="font-semibold">{notice.title}</p>
      {notice.lines.map((line) => (
        <p key={line} className="mt-1 text-sm">{line}</p>
      ))}
      <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={hide}>Hide this note</button>
    </div>
  );
}
