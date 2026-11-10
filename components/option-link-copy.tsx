"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";
import { optionLinkPath } from "@/lib/option-link-rules";

/**
 * "Copy link to this option" beside one price option in the studio (630
 * [HN6](27)): the product page's address with this option chosen, for a sales
 * page or an email. Without scripts it is a plain link that opens that page in
 * a new tab, so it still works and can be copied from the browser.
 */
export function OptionLinkCopy({ path, optionId, label }: { path: string; optionId: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const href = optionLinkPath(path, optionId);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={async (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (!navigator.clipboard) return;
        event.preventDefault();
        try {
          await navigator.clipboard.writeText(`${window.location.origin}${href}`);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2200);
        } catch {
          window.open(href, "_blank", "noopener,noreferrer");
        }
      }}
      className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-[8px] text-sm font-semibold text-violet-deep underline-offset-4 hover:underline"
    >
      <Icon name={copied ? "check" : "link"} size={15} />
      <span aria-live="polite">{copied ? "Link copied" : `Copy a link that opens ${label} chosen`}</span>
    </a>
  );
}
