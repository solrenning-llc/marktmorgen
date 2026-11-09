"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { sweepGiftTyped } from "@/lib/gift-typed";

/**
 * Nothing on screen. Removes from the tab's own storage what a gift form kept
 * (lib/gift-typed.ts) once it can no longer be used: on every page of a store
 * (app/[handle]/layout.tsx), each time the page changes, what is too old; with
 * `all`, on the thank-you page (app/[handle]/thanks/layout.tsx) and on the
 * store's front page, where the checkout comes back (app/[handle]/page.tsx),
 * all of it. Privacy policy: #gift-typed.
 */
export function GiftTypedSweeper({ all = false }: { all?: boolean }) {
  const path = usePathname();
  useEffect(() => {
    try {
      sweepGiftTyped(window.sessionStorage, Date.now(), all);
    } catch {
      // Storage refused (private mode, blocked): nothing was kept either.
    }
  }, [path, all]);
  return null;
}
