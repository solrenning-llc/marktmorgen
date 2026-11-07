"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { AI_CRAWLERS } from "@/lib/ai-crawlers";

/** What the switch says, in plain words, each what the code does (lib/ai-crawlers.ts, storeRobots). */
export const AI_CRAWLERS_WORDS = {
  what: "This asks the AI crawlers named below to stay out of your store on your own domain. It adds a rule for each one to your domain's robots.txt, the file crawlers check first. Crawlers that follow these rules stay out. Not every crawler does, so we cannot promise that none will read your store.",
  search: "Google Search, Bing and other search engines are not asked to stay out, so people can still find your store there. AI answers built on those search results may still show it.",
  address: "Your store's address on marktmorgen.com keeps our site's own rules, which let AI crawlers in.",
  delay: "Crawlers keep a copy of these rules, so a change can take up to a day to reach them.",
  noDomain: "You have no domain of your own live now, so this rule is not in use. It works again when your domain is live.",
} as const;

/**
 * The creator's choice of whether AI crawlers are asked to stay out of the
 * store on its own domain (601 [KB22] U8), with what it does and what it
 * cannot do. Shown in "Can people find your store?" only where it does
 * something: a live domain of the store's own, or a closed choice to undo.
 */
export function AiCrawlersSwitch({ open: initial, ownDomain }: { open: boolean; ownDomain: boolean }) {
  const [open, setOpen] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      const response = await fetch("/api/store/ai-crawlers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ open: !open }) });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; open?: boolean };
      if (body.ok && typeof body.open === "boolean") {
        setOpen(body.open);
        toast(body.open ? "AI crawlers may read your store on your own domain again." : "AI crawlers are now asked to stay out of your own domain.");
      } else toast("That did not save. Try again.");
    } catch {
      toast("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-2xl bg-paper p-4 ring-1 ring-line" data-ai-crawlers={open ? "open" : "closed"}>
      <h3 className="font-semibold text-ink">
        AI crawlers on your own domain
      </h3>
      <p className="mt-1 max-w-[80ch] text-sm text-ink">
        {open ? "Now: AI crawlers may read your store's public pages on your own domain." : "Now: AI crawlers are asked to stay out of your store on your own domain."}
      </p>
      {!ownDomain ? <p className="mt-2 max-w-[80ch] text-sm text-ink">{AI_CRAWLERS_WORDS.noDomain}</p> : null}
      <p className="mt-2 max-w-[80ch] text-sm text-ink-soft">{AI_CRAWLERS_WORDS.what}</p>
      <p className="mt-2 max-w-[80ch] text-sm text-ink-soft">{AI_CRAWLERS_WORDS.search}</p>
      <p className="mt-2 max-w-[80ch] text-sm text-ink-soft">{AI_CRAWLERS_WORDS.address}</p>
      <p className="mt-2 max-w-[80ch] text-sm text-ink-soft">{AI_CRAWLERS_WORDS.delay}</p>
      <p className="mt-2 max-w-[80ch] text-sm text-ink-soft [overflow-wrap:anywhere]">
        {`Named crawlers: ${AI_CRAWLERS.map((crawler) => crawler.agent).join(", ")}.`}
      </p>
      <button type="button" className="btn btn-secondary mt-4" disabled={busy} onClick={() => void toggle()}>
        {open ? "Ask AI crawlers to stay out" : "Let AI crawlers in again"}
      </button>
    </div>
  );
}
