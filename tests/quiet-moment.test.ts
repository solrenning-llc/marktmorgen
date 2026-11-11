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
import { FunnelBeacon, StoreBeacon } from "@/components/store-beacon";
import { QUIET_INPUTS, QUIET_MS, countsAtPause, whenQuiet } from "@/lib/quiet-moment";
import { sourceTag } from "@/lib/source-rules";
import { mount } from "./beacon-react-stub";
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

/**
 * A store page in the synthetic window and document: the beacons read the globals, as in a browser. Each count
 * they send by fetch is kept, decoded. `go` is a soft navigation (next/link): the address changes, nothing reloads.
 */
function storePage(href: string, referrer = "") {
  const page = fakePage();
  const sentCounts: Record<string, string>[] = [];
  const address = { href, search: new URL(href).search };
  Object.assign(page.on.doc, { referrer });
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = page.on.win;
  globals.document = page.on.doc;
  globals.location = address;
  globals.fetch = (_url: string, init: { body: string }) => {
    sentCounts.push(JSON.parse(init.body));
    return Promise.resolve();
  };
  return {
    ...page,
    sentCounts,
    go(to: string) {
      address.href = to;
      address.search = new URL(to).search;
    },
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

  part("Canceled, it never runs and stops listening");
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

  part(
    "A count still waiting when the buyer moves inside the store goes at the next pause, once, as it was read",
  );
  {
    // A tap on a next/link card moves inside the store: the front page's effect is cleaned up, the page is never
    // hidden. The visit's count must not be dropped there (review of #3642, MEDIUM 1).
    const page = fakePage();
    const count = countsAtPause(page.on);
    const sent: string[] = [];
    const visit = JSON.stringify({ h: "shop", k: "v", r: "https://news.example/", u: "news", m: "email", g: "launch" });
    count("shop|/shop", () => sent.push(visit));
    page.advance(800);
    page.press();
    // React's double effect, and the same page mounted again, ask once more: still one count.
    count("shop|/shop", () => sent.push("a second copy"));
    page.advance(QUIET_MS - 1);
    page.idle();
    is("nothing yet: the buyer is still moving", sent, []);
    page.advance(1);
    page.idle();
    is("at the pause, exactly once, with the source read when the page opened", sent, [visit]);
    count("shop|/shop", () => sent.push("again"));
    page.advance(QUIET_MS * 3);
    page.idle();
    page.hide();
    is("never again for the same page", sent, [visit]);
    is("and nothing left listening", page.listening(), 0);
  }
  {
    // A buyer who never pauses: a tap every 1.5 s for 20 s, then a move to a product, then the page is left.
    const page = fakePage();
    const count = countsAtPause(page.on);
    let sent = 0;
    count("shop|/shop", () => sent++);
    for (let elapsed = 0; elapsed < 20_000; elapsed += 1_500) {
      page.advance(1_500);
      page.idle();
      page.press();
    }
    count("shop|/shop/p/book", () => sent++);
    is("no count lands while the buyer keeps tapping", sent, 0);
    page.hide();
    is("leaving sends both, the visit and the product's page", sent, 2);
  }

  part("A visit's count still goes after a move inside the store, with its first source");
  {
    const page = storePage(
      "https://marktmorgen.test/shop-a?utm_source=newsletter&utm_medium=email&utm_campaign=fall",
      "https://referrer.example/post",
    );
    const leave = mount(StoreBeacon, { handle: "shop-a" });
    page.advance(800);
    page.press();
    page.advance(50);
    leave();
    page.go("https://marktmorgen.test/shop-a/p/guide");
    is("nothing goes before the quiet moment", page.sentCounts.length, 0);
    page.advance(30_000);
    page.idle();
    is("one count goes at the quiet moment, with the source read as the page opened", page.sentCounts, [
      {
        h: "shop-a",
        k: "v",
        r: "https://referrer.example/post",
        u: sourceTag(new URLSearchParams("utm_source=newsletter")),
        m: "email",
        g: "fall",
      },
    ]);
    page.advance(30_000);
    page.idle();
    page.hide();
    is("and only once", page.sentCounts.length, 1);
    is("nothing is left listening", page.listening(), 0);
  }

  part("A buyer who taps every 1.5 seconds and then moves on is still counted, once");
  {
    const page = storePage("https://marktmorgen.test/shop-b?utm_source=podcast", "");
    const leave = mount(StoreBeacon, { handle: "shop-b" });
    for (let at = 0; at < 20_000; at += 1_500) {
      page.advance(1_500);
      page.press();
      page.idle();
    }
    is("nothing goes while the buyer keeps tapping", page.sentCounts.length, 0);
    page.press();
    leave();
    page.go("https://marktmorgen.test/shop-b/p/course");
    page.advance(30_000);
    page.idle();
    is("one count goes later, with its source", page.sentCounts.map((count) => [count.k, count.u]), [
      ["v", sourceTag(new URLSearchParams("utm_source=podcast"))],
    ]);
  }

  part("React running the effect twice still sends one count");
  {
    const page = storePage("https://marktmorgen.test/shop-c?utm_source=first", "https://referrer.example/");
    mount(StoreBeacon, { handle: "shop-c" })();
    const leave = mount(StoreBeacon, { handle: "shop-c" });
    page.advance(QUIET_MS);
    page.idle();
    leave();
    page.advance(30_000);
    page.idle();
    is("one count", page.sentCounts.map((count) => count.k), ["v"]);
    mount(StoreBeacon, { handle: "shop-c" })();
    page.advance(30_000);
    page.idle();
    is("and none again for the same page load", page.sentCounts.length, 1);
  }

  part("A page hidden after a move inside the store sends its count at once");
  {
    const page = storePage("https://marktmorgen.test/shop-d?utm_source=social", "");
    const leave = mount(StoreBeacon, { handle: "shop-d" });
    page.advance(800);
    page.press();
    leave();
    page.go("https://marktmorgen.test/shop-d/blog");
    page.hide();
    is("at the moment the page is hidden", page.sentCounts.map((count) => [count.k, count.u]), [
      ["v", sourceTag(new URLSearchParams("utm_source=social"))],
    ]);
  }

  part("A funnel step still goes after a move to the next step");
  {
    const page = storePage("https://marktmorgen.test/shop-e/launch?f=spring", "");
    const leave = mount(FunnelBeacon, { handle: "shop-e", funnel: "spring", kind: "page", id: "launch" });
    page.advance(800);
    page.press();
    page.advance(50);
    leave();
    page.go("https://marktmorgen.test/shop-e/p/course?f=spring");
    page.advance(30_000);
    page.idle();
    is("one step goes at the quiet moment", page.sentCounts, [
      { h: "shop-e", k: "f", f: "spring", t: "g", id: "launch" },
    ]);
    is("nothing is left listening", page.listening(), 0);

    const twice = storePage("https://marktmorgen.test/shop-f/launch?f=fall", "");
    mount(FunnelBeacon, { handle: "shop-f", funnel: "fall", kind: "product", id: "course" })();
    const stay = mount(FunnelBeacon, { handle: "shop-f", funnel: "fall", kind: "product", id: "course" });
    twice.advance(QUIET_MS);
    twice.idle();
    stay();
    is("React running the effect twice still sends one step", twice.sentCounts.map((count) => [count.k, count.t]), [["f", "p"]]);

    const hidden = storePage("https://marktmorgen.test/shop-g/launch?f=winter", "");
    const gone = mount(FunnelBeacon, { handle: "shop-g", funnel: "winter", kind: "page", id: "launch" });
    hidden.press();
    gone();
    hidden.hide();
    is("a page hidden after the move sends the step at once", hidden.sentCounts.map((count) => count.k), ["f"]);
  }

  part("The inputs it waits on and the counts that use it");
  is("a press, a tap or a key", [...QUIET_INPUTS], ["pointerdown", "keydown"]);
  const beacon = readFileSync("components/store-beacon.tsx", "utf8");
  is(
    "the visit, the page's count and a funnel step wait for the pause, and nothing cancels one still waiting",
    [
      /const countOnce = countsAtPause\(\);/.test(beacon),
      /countOnce\(key, \(\) => beacon\(payload\)\);/.test(beacon),
      /countOnce\(`\$\{handle\}\|\$\{location\.href\}\|funnel`, \(\) =>\s*beacon\(\{ h: handle, k: "f"/.test(beacon),
      /cancel/.test(beacon.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")),
    ],
    [true, true, true, false],
  );
  is(
    "a link's count, which needs no check, still goes at once by sendBeacon",
    /if \(id\) beacon\(\{ h: handle, k: "l", id \}\)/.test(beacon),
    true,
  );

  done();
}

main();
