"use client";

import { useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/icons";

// Shown only once scripts run: before that, or without them, nothing here could work, so nothing is offered (VR 2).
const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/**
 * "Copy link" and "Print" for one help answer on its own page (564 [HC1]).
 * Copy puts the page's own address on the clipboard and says so in words; Print
 * opens the browser's print dialog, and the page's print style leaves out the
 * site's menus, footer and the other answers (app/help/[section]/[answer]).
 */
export function HelpAnswerTools() {
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [said, setSaid] = useState("");
  if (!ready) return null;
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 print:hidden" data-help-answer-tools>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}`);
            setSaid("Link copied.");
          } catch {
            setSaid("The link could not be copied here. Copy it from the address bar instead.");
          }
        }}
      >
        <Icon name="link" size={16} /> Copy link
      </button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>
        Print
      </button>
      <p role="status" className="text-sm text-ink-soft">{said}</p>
    </div>
  );
}
