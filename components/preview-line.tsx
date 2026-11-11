"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The line every public page shows above the site menu while plans are not on sale, already decided.
 * The decision (lib/opening.ts, PLANS_ON_SALE) runs the whole commercial review, which is server work:
 * the root layout reads it on the server and hands the menu only the finished words, so no browser has
 * to download and execute that review to learn a constant (tests/site-nav-bundle.test.ts).
 */
export type PreviewLine = { line: string; href: string; label: string } | null;

const PreviewLineContext = createContext<PreviewLine | undefined>(undefined);

export function PreviewLineProvider({ value, children }: { value: PreviewLine; children: ReactNode }) {
  return <PreviewLineContext.Provider value={value}>{children}</PreviewLineContext.Provider>;
}

/** The decided line, or null once plans are on sale. Outside the root layout there is no decision to read: that is a bug, said loudly. */
export function usePreviewLine(): PreviewLine {
  const value = useContext(PreviewLineContext);
  if (value === undefined) throw new Error("The site menu is drawn outside the root layout's PreviewLineProvider");
  return value;
}
