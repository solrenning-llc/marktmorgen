"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";

/**
 * A link to one answer. It works as a plain link without scripts; with them,
 * pressing it also copies the full address, so it can be pasted to someone.
 */
export function CopyLink({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <a
      href={`#${id}`}
      onClick={async (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (!navigator.clipboard) return;
        event.preventDefault();
        const url = `${window.location.origin}${window.location.pathname}#${id}`;
        try {
          await navigator.clipboard.writeText(url);
          window.history.replaceState(null, "", `#${id}`);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2200);
        } catch {
          window.location.hash = id;
        }
      }}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-[8px] text-sm font-semibold text-violet-deep underline-offset-4 hover:underline"
    >
      <Icon name={copied ? "check" : "link"} size={15} />
      <span aria-live="polite">{copied ? "Link copied" : "Copy a link to this answer"}</span>
    </a>
  );
}
