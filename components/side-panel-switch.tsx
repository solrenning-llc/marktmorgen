"use client";

/**
 * The switch at the top of the page editor's right-hand column on a wide
 * screen: "Add blocks" or "Preview", one press apart (375 [TB1]; the choice
 * and its default are in lib/side-panel.ts). Two buttons, each saying whether
 * it is on, as the editor's other switches do (Build or Preview, Computer or
 * Phone).
 */
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { SIDE_PANELS, SIDE_PANEL_DEFAULT, SIDE_PANEL_KEY, SIDE_PANEL_LABEL, type SidePanel, readSidePanel } from "@/lib/side-panel";

/**
 * What the column shows: the choice remembered in this browser only (the
 * default until it is read, or when the browser keeps nothing), a choice that
 * is remembered, and a change the editor makes by itself, which is not.
 */
export function useSidePanel(): [SidePanel, (next: SidePanel) => void, (next: SidePanel) => void] {
  const [panel, setPanel] = useState<SidePanel>(SIDE_PANEL_DEFAULT);
  useEffect(() => {
    const first = window.setTimeout(() => {
      try {
        setPanel(readSidePanel(window.localStorage.getItem(SIDE_PANEL_KEY)));
      } catch {
        // Storage blocked: the default stays.
      }
    }, 0);
    return () => window.clearTimeout(first);
  }, []);
  const choose = (next: SidePanel) => {
    setPanel(next);
    try {
      window.localStorage.setItem(SIDE_PANEL_KEY, next);
    } catch {
      // Not remembered; the choice still holds on this page.
    }
  };
  return [panel, choose, setPanel];
}

/** Two buttons, Add blocks and Preview; the one on says so in words and with a check, not by color alone. Focus stays where it is. */
export function SidePanelSwitch({ value, onChange, controls }: { value: SidePanel; onChange: (next: SidePanel) => void; controls: string }) {
  return (
    <div className="flex rounded-full bg-paper p-1 ring-1 ring-line" role="group" aria-label="Beside the blocks">
      {SIDE_PANELS.map((panel) => {
        const on = value === panel;
        return (
          <button
            key={panel}
            type="button"
            aria-pressed={on}
            aria-controls={controls}
            onClick={() => onChange(panel)}
            className={`inline-flex min-h-11 min-w-11 flex-1 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-semibold ${on ? "bg-white text-ink shadow-sm ring-1 ring-line" : "text-ink-soft hover:text-ink"}`}
          >
            <Icon name={panel === "add" ? "plus" : "window"} size={16} />
            {SIDE_PANEL_LABEL[panel]}
            {on ? <Icon name="check" size={16} /> : null}
          </button>
        );
      })}
    </div>
  );
}
