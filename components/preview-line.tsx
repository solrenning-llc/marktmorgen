"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The line every public page shows above the site menu while plans are not on sale, already decided.
 * The decision (lib/opening.ts, PLANS_ON_SALE) runs the whole commercial review, which is server work:
 * the root layout reads it on the server and hands the menu only the finished words, so no browser has
 * to download and execute that review to learn a constant (tests/site-nav-bundle.test.ts).
 */
export type PreviewLine = { line: string; href: string; label: string } | null;

/**
 * Every page under app/ is drawn inside the root layout, which always provides the decided line, so the
 * default is only ever read where no page is: a test drawing a page's parts on their own. There the menu
 * draws no line rather than failing; the layout's own render is what tests/site-nav-bundle.test.ts holds.
 */
const PreviewLineContext = createContext<PreviewLine>(null);

export function PreviewLineProvider({ value, children }: { value: PreviewLine; children: ReactNode }) {
  return <PreviewLineContext.Provider value={value}>{children}</PreviewLineContext.Provider>;
}

/** The decided line, or null once plans are on sale. */
export function usePreviewLine(): PreviewLine {
  return useContext(PreviewLineContext);
}
