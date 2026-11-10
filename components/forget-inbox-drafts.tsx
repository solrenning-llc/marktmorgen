"use client";

import { useEffect } from "react";
import { browserDrafts, forgetDrafts } from "@/lib/inbox-drafts";

/**
 * Drawn on the page every log-out lands on (app/signin/page.tsx, status
 * "out…"): removes from this device every unsent inbox answer kept for the
 * person who just logged out (lib/inbox-drafts.ts). Draws nothing.
 */
export function ForgetInboxDrafts() {
  useEffect(() => {
    forgetDrafts(browserDrafts());
  }, []);
  return null;
}
