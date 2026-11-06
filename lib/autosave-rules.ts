/**
 * When a studio editor may save by itself (487 [IT4], pattern 6, unit 1;
 * added 1 November 2026). Rules only: no editor saves by itself yet, and
 * nothing here writes anything.
 *
 * Where it may. A save by itself only where saving changes nothing anyone
 * else sees and loses nothing: a draft or a hidden item, on a store that pays
 * for its plan. Never where Save puts the change live (a page that is on, a
 * product or post that is published), moves the versions kept to undo with
 * (lib/sales-page-store.ts keeps five), deletes a file, or restarts a test
 * (an A/B test starts its count again on a save): there the creator presses
 * Save, as today. Each editor that takes it up says which of its saves are of
 * the first kind, one by one.
 *
 * What it costs. A save, pressed or not, is one studio request
 * (lib/studio-route.ts, countStudio), and a studio request is priced at its
 * own shape (tests/plan-cost-registry.ts, UNIT_COST.studio: twenty commands
 * and fifty kilobytes through the database), counted at every plan's full
 * figure (tests/spend-floor.test.ts). A save heavier than that (a sales page
 * of hundreds of kilobytes, one that checks pictures in the file store, one
 * that reindexes a course for the community search) is not inside that
 * price, so it never saves by itself: only a draft of at most
 * AUTOSAVE_MAX_BYTES, on a route whose save stays inside the shape.
 *
 * Its own ceiling, on the server. Saves by itself may use at most
 * AUTOSAVE_SHARE of the window's studio figure, counted on the server (the
 * next unit: a count kept with the window, registered in
 * tests/store-data-registry.ts first). Until that count can be read, it does
 * not save by itself at all: unknown is never room. The rest of the window is
 * what the studio has without them, as today. When the whole window is used,
 * the studio rests for every request, pressed saves included
 * (lib/studio-route.ts); saves by itself never take more than their share of
 * it.
 *
 * In the browser, besides: it waits until the typing stops
 * (AUTOSAVE_IDLE_MS), saves at most once every AUTOSAVE_GAP_MS and at most
 * AUTOSAVE_PER_OPEN times while one editor stays open, and does not try
 * again a draft its route refused until it changes. These bound one tab, not
 * the store: reloading or a second tab starts them again, which is why the
 * share above is counted on the server. A try is counted when it starts.
 *
 * Browser-safe: plain data and pure functions. autosaveWords reads the time
 * in the creator's own clock, so it is drawn in the browser only.
 */

/** How long the typing must have stopped before a save by itself. */
export const AUTOSAVE_IDLE_MS = 4_000;
/** The least time between two saves by itself, from the start of one try to the next. */
export const AUTOSAVE_GAP_MS = 60_000;
/** The most saves by itself while one editor stays open. */
export const AUTOSAVE_PER_OPEN = 60;
/** The share of the window's studio figure saves by itself may use, counted on the server. */
export const AUTOSAVE_SHARE = 0.25;
/** The largest draft saved by itself, so its reading and writing stay inside a studio request's priced fifty kilobytes. */
export const AUTOSAVE_MAX_BYTES = 20_000;

export type AutosaveInput = {
  /** Whether there is anything unsaved. */
  dirty: boolean;
  /** Whether a save, either kind, is on its way now. */
  saving: boolean;
  /** Whether the draft as it stands can be saved at all (a required field empty: no). */
  valid: boolean;
  /** Whether this save changes nothing anyone else sees and loses nothing: a draft or a hidden item, no version moved, no file deleted, no test restarted. */
  private: boolean;
  /** Whether the store pays for its plan (lib/plan-standing.ts, "paid"). */
  paying: boolean;
  /** The draft's size as it would be sent, in bytes. */
  bytes: number;
  /** Whether the route refused this very draft; cleared by the next change. */
  refused: boolean;
  now: number;
  /** The last change typed, in milliseconds. */
  changedAt: number;
  /** When the last try by itself started, in milliseconds; 0 for none yet. */
  autosavedAt: number;
  /** Tries by itself since the editor opened. */
  autosaves: number;
  /** The window's studio figure and what saves by itself used of it, counted on the server; null when it could not be read. */
  window: { figure: number; autosaved: number } | null;
};

export type AutosaveOff = "private" | "paying" | "big" | "refused" | "many" | "unknown" | "share" | "invalid";
export type AutosaveDecision = { act: "save" } | { act: "wait"; until: number } | { act: "idle" } | { act: "off"; why: AutosaveOff };

const time = (n: number) => Number.isFinite(n) && n >= 0;

export function autosaveDecision(input: AutosaveInput): AutosaveDecision {
  if (!input.dirty || input.saving) return { act: "idle" };
  // Where it never may: Save is pressed there, as today.
  if (!input.private) return { act: "off", why: "private" };
  if (!input.paying) return { act: "off", why: "paying" };
  if (!Number.isFinite(input.bytes) || input.bytes > AUTOSAVE_MAX_BYTES) return { act: "off", why: "big" };
  if (input.refused) return { act: "off", why: "refused" };
  // Anything not read as a plain figure stops it: unknown is never room.
  if (!time(input.now) || !time(input.changedAt) || !time(input.autosavedAt) || input.changedAt > input.now || input.autosavedAt > input.now) return { act: "off", why: "unknown" };
  if (!Number.isSafeInteger(input.autosaves) || input.autosaves < 0) return { act: "off", why: "unknown" };
  if (input.autosaves >= AUTOSAVE_PER_OPEN) return { act: "off", why: "many" };
  const w = input.window;
  if (!w || !Number.isSafeInteger(w.figure) || w.figure <= 0 || !Number.isSafeInteger(w.autosaved) || w.autosaved < 0 || w.autosaved > w.figure) return { act: "off", why: "unknown" };
  if (w.autosaved >= Math.floor(w.figure * AUTOSAVE_SHARE)) return { act: "off", why: "share" };
  // Last, so a draft that cannot be saved is never told it will save once filled in when something else stops it too.
  if (!input.valid) return { act: "off", why: "invalid" };
  const until = Math.max(input.changedAt + AUTOSAVE_IDLE_MS, input.autosavedAt ? input.autosavedAt + AUTOSAVE_GAP_MS : 0);
  return input.now >= until ? { act: "save" } : { act: "wait", until };
}

/** What the editor says beside its Save button, in plain words. Only what is unsaved is warned about. */
export function autosaveWords(state: { saving: boolean; savedAt: number | null; off: AutosaveDecision | null; dirty: boolean }): string {
  if (state.saving) return "Saving…";
  if (state.dirty) {
    const why = state.off?.act === "off" ? state.off.why : null;
    if (why === "refused") return "Not saved: see what to change, then press Save.";
    if (why === "invalid") return "Not saved yet: fill in what is missing, then press Save.";
    // Waiting to save by itself, or never doing so here: either way it is not saved yet.
    return why ? "Not saved yet: press Save." : "Not saved yet.";
  }
  if (state.savedAt) {
    const at = new Date(state.savedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `Saved at ${at}.`;
  }
  return "";
}
