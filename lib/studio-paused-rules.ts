/**
 * What the paused studio screen (app/studio/paused/page.tsx) offers besides its words, so a pause never leaves the
 * creator without a way on (Codex N1 LOWs on #3561; tests/studio-paused-recovery.test.ts). The month's figure used,
 * no place in the free pool or a count that could not be read: everything that never pauses (the sales download,
 * canceling), the studio and support. The daily limit stops plan changes, cancellations and downloads themselves,
 * so those are not offered then, and neither are they when the screen's details are not drawn; the studio and
 * support always are. Each is still drawn only where the page's own checks (role, billing) allow it.
 */
export type PausedWhy = "used" | "pool" | "unknown" | "daily";
export type PausedAction = "export" | "cancel" | "studio" | "support";

export function pausedActions(why: PausedWhy, shown: boolean): PausedAction[] {
  if (!shown || why === "daily") return ["studio", "support"];
  return ["export", "cancel", "studio", "support"];
}
