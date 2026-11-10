"use client";

import { useEffect } from "react";
import { browserStorage, forgetEveryonesDrafts } from "@/lib/inbox-drafts";

/**
 * Drawn on the sign-in page, where every log-out and every ended session
 * lands (app/signin/page.tsx): removes from this device every person's
 * unsent inbox answers (lib/inbox-drafts.ts). Draws nothing.
 */
export function ForgetInboxDrafts() {
  useEffect(() => {
    forgetEveryonesDrafts(browserStorage());
  }, []);
  return null;
}
