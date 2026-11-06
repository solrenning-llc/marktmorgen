import { Figtree, Unbounded } from "next/font/google";

/*
 * The two faces of the morning look (VS1, queue item 571), loaded once and
 * shared by every page that uses it: the home page, /signin and /pricing.
 * Both SIL Open Font License, served from our own domain by next/font.
 * Optional display: a cold phone keeps the fallback rather than shifting
 * the headline when a font arrives late.
 */
const display = Unbounded({ variable: "--font-hm-display", subsets: ["latin"], weight: ["600", "800"], display: "optional" });
const body = Figtree({ variable: "--font-hm-body", subsets: ["latin"], display: "optional" });

/** The class that makes both faces available to `.hm` and everything in it. */
export const MORNING_FONTS = `${display.variable} ${body.variable}`;
