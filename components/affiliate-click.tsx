"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { trackingConsentWords } from "@/lib/buyer-words/tracking-consent";
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";

// Once per page load, however many times React runs the effect.
const sent = new Set<string>();

const choiceKey = (handle: string) => `nl_aff_consent:${handle}`;

function readChoice(handle: string): "yes" | "no" | null {
  try {
    const value = localStorage.getItem(choiceKey(handle));
    return value === "yes" || value === "no" ? value : null;
  } catch {
    return null;
  }
}

function writeChoice(handle: string, value: "yes" | "no") {
  try {
    localStorage.setItem(choiceKey(handle), value);
  } catch {
    // A browser that keeps nothing asks again next time; nothing breaks.
  }
}

/**
 * Whether this visit came from a paid search ad: the click ids Google and
 * Microsoft add to an ad's link, or a link tagged as paid search. Read only
 * to tell the creator (lib/affiliate-setting.ts, paidSearch); kept nowhere.
 */
function fromPaidSearch(search: string): boolean {
  const params = new URLSearchParams(search);
  if (["gclid", "gbraid", "wbraid", "msclkid"].some((name) => params.has(name))) return true;
  return ["cpc", "ppc", "paidsearch", "paid-search", "sem"].includes((params.get("utm_medium") ?? "").toLowerCase());
}

/** Asks the server to remember the link, now that the visitor said yes. */
function remember(handle: string, code: string) {
  fetch("/api/store/via", {
    method: "POST",
    body: JSON.stringify({ h: handle, c: code }),
    headers: { "Content-Type": "application/json" },
    keepalive: true,
  }).catch(() => {});
}

/**
 * A visitor who arrived through an affiliate's link.
 *
 * The click is counted for the affiliate either way. The cookie that credits
 * a later purchase is set by the server on arrival (proxy.ts), except where
 * the law asks for consent first (`askFirst`): there this asks, in plain
 * words, and the cookie is set only after a yes. The answer is kept for this
 * store on this device, so a visitor who said yes is not asked again and one
 * who said no is not asked again either. It speaks the store's language
 * (lib/buyer-words/tracking-consent.ts) and says so (`lang`).
 */
export function AffiliateClick({
  handle,
  storeName,
  days,
  askFirst,
  language,
}: {
  handle: string;
  storeName: string;
  days: number;
  askFirst: boolean;
  /** The store's language (lib/store-language.ts); English when missing or unknown. */
  language?: LanguageCode;
}) {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    const found = new URLSearchParams(location.search).get("via")?.toLowerCase() ?? "";
    if (!/^[a-z0-9]{3,20}$/.test(found)) return;
    const key = `${handle}|${found}|${location.pathname}`;
    if (!sent.has(key)) {
      sent.add(key);
      const body = JSON.stringify({ h: handle, k: "a", c: found, ...(fromPaidSearch(location.search) ? { p: "1" } : {}) });
      let beaconed = false;
      try {
        beaconed = Boolean(navigator.sendBeacon && navigator.sendBeacon("/api/store/hit", new Blob([body], { type: "text/plain" })));
      } catch {
        beaconed = false;
      }
      if (!beaconed) {
        fetch("/api/store/hit", { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
      }
    }
    if (!askFirst) return;
    const choice = readChoice(handle);
    if (choice === "yes") {
      remember(handle, found);
      return;
    }
    if (choice === "no") return;
    // Read from this browser's address bar and storage, which only exist once the page is in it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCode(found);
  }, [handle, askFirst]);

  if (!code) return null;

  const spoken = parseLanguage(language);
  const words = trackingConsentWords(spoken);
  return (
    <section
      lang={LANGUAGES[spoken].locale}
      aria-label={words.affiliateLabel}
      className="st-card fixed inset-x-3 top-3 z-50 mx-auto max-w-xl p-5 text-left sm:inset-x-6 sm:top-6"
      style={{ boxShadow: "0 18px 50px -18px rgba(0,0,0,.45)" }}
    >
      <p className="font-bold">{words.affiliateTitle(storeName)}</p>
      <p className="st-muted mt-1 text-sm leading-relaxed">
        {words.affiliateBody(days)}{" "}
        <Link href="/privacy#affiliates" className="st-footer-link font-semibold">
          {words.more}
        </Link>
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn st-btn"
          onClick={() => {
            writeChoice(handle, "yes");
            remember(handle, code);
            setCode(null);
          }}
        >
          {words.allow}
        </button>
        <button
          type="button"
          className="btn st-option !w-auto !py-2.5 font-semibold"
          onClick={() => {
            writeChoice(handle, "no");
            setCode(null);
          }}
        >
          {words.noThanks}
        </button>
      </div>
    </section>
  );
}
