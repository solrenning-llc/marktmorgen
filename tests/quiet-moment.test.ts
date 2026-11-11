/**
 * A store page's counts wait for a pause in what the buyer is doing
 * (lib/quiet-moment.ts), because the host's check behind them runs one block
 * of script that cannot be split: sent as the page was drawn, it landed on
 * the buyer's first tap, which took 256 to 320 ms to paint on the mobile
 * render lab's slowed phone (11 November 2026).
 *
 * Exercised with a synthetic window and document and a hand-driven clock.
 */
import { readFileSync } from "node:fs";
import { QUIET_INPUTS, QUIET_MS, whenQuiet } from "@/lib/quiet-moment";
import { done, is, part } from "./check";

type Listener = (event?: unknown) => void;

function fakePage({
  readyState = "complete",
  visibilityState = "visible",
  idle = true,
}: {
  readyState?: DocumentReadyState;
  visibilityState?: DocumentVisibilityState;
  idle?: boolean;
} = {}) {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const idles = new Map<number, () => void>();
  const listeners = {
    win: new Map<string, Set<Listener>>(),
    doc: new Map<string, Set<Listener>>(),
  };
  const on =
    (where: Map<string, Set<Listener>>) =>
    (name: string, listener: Listener) => {
      if (!where.has(name)) where.set(name, new Set());
      where.get(name)!.add(listener);
    };
  const off =
    (where: Map<string, Set<Listener>>) =>
    (name: string, listener: Listener) => {
      where.get(name)?.delete(listener);
    };
  const win = {
    setTimeout: (run: () => void, ms = 0) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id?: number) => {
      if (id !== undefined) timers.delete(id);
    },
    addEventListener: on(listeners.win),
    removeEventListener: off(listeners.win),
    ...(idle
      ? {
          requestIdleCallback: (run: () => void) => {
            const id = next++;
            idles.set(id, run);
            return id;
          },
          cancelIdleCallback: (id: number) => {
            idles.delete(id);
          },
        }
      : {}),
  };
  const doc: {
    readyState: DocumentReadyState;
    visibilityState: DocumentVisibilityState;
    addEventListener: (name: string, listener: Listener) => void;
    removeEventListener: (name: string, listener: Listener) => void;
  } = {
    readyState,
    visibilityState,
    addEventListener: on(listeners.doc),
    removeEventListener: off(listeners.doc),
  };
  const fire = (where: Map<string, Set<Listener>>, name: string) =>
    [...(where.get(name) ?? [])].forEach((listener) => listener());
  return {
    /** The synthetic window and document, as whenQuiet takes them. */
    on: { win: win as unknown as Window, doc: doc as unknown as Document },
    /** Moves the clock, running each timer that comes due, in order. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
    /** The browser has an idle moment: every idle callback waiting runs. */
    idle() {
      const waiting = [...idles.values()];
      idles.clear();
      waiting.forEach((run) => run());
    },
    press: (name: string = "pointerdown") => fire(listeners.doc, name),
    load() {
      doc.readyState = "complete";
      fire(listeners.win, "load");
    },
    hide() {
      doc.visibilityState = "hidden";
      fire(listeners.doc, "visibilitychange");
    },
    listening: () =>
      [...listeners.win.values(), ...listeners.doc.values()].reduce(
        (sum, set) => sum + set.size,
        0,
      ),
  };
}

function main(): void {
  part(
    "Nothing runs while the buyer is pressing; it runs after a quiet moment and an idle one",
  );
  {
    const page = fakePage();
    let runs = 0;
    whenQuiet(() => runs++, page.on);
    page.advance(QUIET_MS - 1);
    page.idle();
    is("not before the quiet moment", runs, 0);
    page.press();
    page.advance(QUIET_MS - 1);
    page.idle();
    is("a tap starts the wait again", runs, 0);
    page.press("keydown");
    page.advance(QUIET_MS);
    is(
      "a key starts it again too, and an idle moment is still waited for",
      runs,
      0,
    );
    page.idle();
    is("then it runs", runs, 1);
    page.press();
    page.advance(QUIET_MS * 3);
    page.idle();
    page.hide();
    is("once only", runs, 1);
    is("and stops listening", page.listening(), 0);
  }

  part("A tap after the idle moment was asked for still waits again");
  {
    const page = fakePage();
    let runs = 0;
    whenQuiet(() => runs++, page.on);
    page.advance(QUIET_MS);
    page.press();
    page.idle();
    is("the idle moment asked for before the tap is dropped", runs, 0);
    page.advance(QUIET_MS);
    page.idle();
    is("it runs after the next quiet moment", runs, 1);
  }

  part("The page's load comes first; a tap before it changes nothing");
  {
    const page = fakePage({ readyState: "interactive" });
    let runs = 0;
    whenQuiet(() => runs++, page.on);
    page.press();
    page.advance(QUIET_MS * 3);
    page.idle();
    is("never before the load", runs, 0);
    page.load();
    page.advance(QUIET_MS);
    page.idle();
    is("the quiet moment counts from the load", runs, 1);
  }

  part("A hidden page has no tap waiting: it runs at once");
  {
    const page = fakePage();
    let runs = 0;
    whenQuiet(() => runs++, page.on);
    page.advance(100);
    page.hide();
    is("at the moment the page is hidden", runs, 1);
    is("and stops listening", page.listening(), 0);
    const hidden = fakePage({ visibilityState: "hidden" });
    let early = 0;
    whenQuiet(() => early++, hidden.on);
    is("already hidden when asked: at once", early, 1);
  }

  part("Without requestIdleCallback, the quiet moment alone");
  {
    const page = fakePage({ idle: false });
    let runs = 0;
    whenQuiet(() => runs++, page.on);
    page.advance(QUIET_MS);
    is("runs right after it", runs, 1);
  }

  part("Cancelled, it never runs and stops listening");
  {
    const page = fakePage();
    let runs = 0;
    const cancel = whenQuiet(() => runs++, page.on);
    cancel();
    page.advance(QUIET_MS * 3);
    page.idle();
    page.hide();
    is("never runs", runs, 0);
    is("nothing left listening", page.listening(), 0);
  }

  part("The inputs it waits on and the counts that use it");
  is("a press, a tap or a key", [...QUIET_INPUTS], ["pointerdown", "keydown"]);
  const beacon = readFileSync("components/store-beacon.tsx", "utf8");
  is(
    "the visit and the page's count wait for it, and the effect cancels it",
    /const cancel = sent\.has\(key\)\s*\?\s*null\s*:\s*whenQuiet\(/.test(
      beacon,
    ) && (beacon.match(/cancel\?\.\(\)/g) ?? []).length === 2,
    true,
  );
  is(
    "a funnel step waits for it too",
    /return whenQuiet\(\(\) => \{\s*if \(sent\.has\(key\)\) return;\s*sent\.add\(key\);\s*beacon\(\{ h: handle, k: "f"/.test(
      beacon,
    ),
    true,
  );
  is(
    "a link's count, which needs no check, still goes at once by sendBeacon",
    /if \(id\) beacon\(\{ h: handle, k: "l", id \}\)/.test(beacon),
    true,
  );

  done();
}

main();
