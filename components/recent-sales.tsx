"use client";

import { useEffect, useRef, useState } from "react";
import { recentWords } from "@/lib/buyer-words/recent";
import type { RecentSale } from "@/lib/recent-sales-rules";

/**
 * When the first card appears, how long each stays, and the pause between two.
 * A card under the pointer or holding the keyboard focus is never taken away:
 * its seven seconds start again when the person leaves it (WCAG 2.2.1, 2.2.3;
 * tests/recent-sales-card-held.test.ts).
 */
const FIRST_MS = 5_000;
const SHOWN_MS = 7_000;
const GAP_MS = 9_000;

/** "2 hours ago", in the store's language, from the real time of the purchase. */
function ago(at: number, locale: string, now: number): string {
  const seconds = Math.max(0, Math.round(now / 1000 - at));
  const words = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds < 3_600) return words.format(-Math.max(1, Math.round(seconds / 60)), "minute");
  if (seconds < 86_400) return words.format(-Math.round(seconds / 3_600), "hour");
  return words.format(-Math.round(seconds / 86_400), "day");
}

function countryName(code: string, locale: string): string {
  if (!code) return "";
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? "";
  } catch {
    return "";
  }
}

/**
 * The store's latest real purchases (lib/recent-sales.ts), one card at a
 * time, each once a visit and never again in a loop: what was bought, when,
 * and the country the card was billed in, never who. Closing it ends it for
 * the rest of the visit. It never disappears from under a person reading or
 * using it: while the pointer is over it or the focus is inside it, it stays.
 */
export function RecentSales({ sales, handle, language, locale }: { sales: RecentSale[]; handle: string; language: string; locale: string }) {
  const words = recentWords(language);
  const [shown, setShown] = useState<{ i: number; now: number } | null>(null);
  const [closed, setClosed] = useState(false);
  const key = `nl:recent-closed:${handle}`;
  /** Whether the pointer is over the card and whether the focus is inside it. */
  const held = useRef({ pointer: false, focus: false });
  /** The card's own seven seconds, waiting for the person to leave it. */
  const resume = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!sales.length) return;
    try {
      if (window.sessionStorage.getItem(key) === "1") return;
    } catch {
      // Storage refused: the cards still show, and closing still ends them on this page.
    }
    // One timer at a time: each card in turn, once, never in a loop.
    let timer = 0;
    let i = 0;
    const show = () => {
      if (i >= sales.length) return;
      setShown({ i, now: Date.now() });
      timer = window.setTimeout(hide, SHOWN_MS);
    };
    const hide = () => {
      if (held.current.pointer || held.current.focus) {
        resume.current = () => {
          timer = window.setTimeout(hide, SHOWN_MS);
        };
        return;
      }
      setShown(null);
      i += 1;
      timer = window.setTimeout(show, GAP_MS);
    };
    timer = window.setTimeout(show, FIRST_MS);
    return () => {
      window.clearTimeout(timer);
      resume.current = null;
    };
  }, [sales, key]);

  const hold = (what: "pointer" | "focus") => {
    held.current[what] = true;
  };
  const letGo = (what: "pointer" | "focus") => {
    held.current[what] = false;
    if (held.current.pointer || held.current.focus) return;
    const go = resume.current;
    resume.current = null;
    go?.();
  };

  const sale = shown && !closed ? sales[shown.i] : null;
  if (!sale || !shown) return null;
  const place = countryName(sale.country, locale);

  return (
    <aside
      className="st-recent st-card"
      aria-label={words.region}
      onPointerEnter={() => hold("pointer")}
      onPointerLeave={() => letGo("pointer")}
      onFocus={() => hold("focus")}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) letGo("focus");
      }}
    >
      <a href={`/@${handle}/p/${sale.product}`} className="st-recent-link">
        <span className="block font-semibold [overflow-wrap:anywhere]">{sale.title}</span>
        <span className="st-muted block text-sm">{`${words.bought(ago(sale.at, locale, shown.now))}${place ? ` · ${place}` : ""}`}</span>
      </a>
      <button
        type="button"
        className="st-recent-close"
        aria-label={words.close}
        onClick={() => {
          setClosed(true);
          try {
            window.sessionStorage.setItem(key, "1");
          } catch {
            // Closed for this page all the same.
          }
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </aside>
  );
}
