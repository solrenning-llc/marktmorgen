"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/icons";

/*
 * Reveals every element with .reveal as it scrolls into view, once.
 *
 * On a first load this has already been done by the script at the end of
 * the body in app/layout.tsx, which runs as soon as the HTML is parsed
 * rather than waiting for this bundle to hydrate. What that script cannot
 * cover is a client-side navigation, where no script in the document runs
 * again and the new page's sections arrive hidden. That is what this is
 * for, so it does exactly the same two things: show whatever is already on
 * screen, and observe the rest.
 */
export function RevealOnScroll() {
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !("IntersectionObserver" in window)
    ) {
      nodes.forEach((n) => n.classList.add("is-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        });
      },
      // A section can exceed ten viewports after its answers open.
      // Reveal on the first intersection, not an unreachable fraction of it.
      { rootMargin: "0px 0px -6% 0px", threshold: 0 },
    );
    const fold = window.innerHeight;
    // Snapshot geometry first. Revealing one node can change layout/style;
    // interleaving writes with the next measurement forces repeated layout.
    const pending = nodes.filter((n) => !n.classList.contains("is-in"));
    const inView = pending.map((n) => n.getBoundingClientRect().top < fold);
    pending.forEach((n, index) => {
      if (inView[index]) n.classList.add("is-in");
      else io.observe(n);
    });
    return () => io.disconnect();
  }, []);
  return null;
}

/*
 * The hero: one store, changing. See HeroFlow for why it is one object
 * rather than the five it used to be.
 */

const REDUCE = "(prefers-reduced-motion: reduce)";
const subscribeReduce = (cb: () => void) => {
  const mq = window.matchMedia(REDUCE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/*
 * Five creators, cycling.
 *
 * The hero used to draw one store, and one store is a diagram. Five, each
 * with a face and a different thing for sale, is a market: the page is
 * for people who sell what they know, so the first thing on it should be
 * people. They change every five seconds, carrying their own colour, so
 * the first screen is never the same twice and never still.
 *
 * All five are stores we built as examples, and the line under the
 * picture says so. Nobody here is presented as a customer.
 */
const STORES = [
  {
    handle: "harborkitchen",
    name: "Harbor Kitchen",
    line: "Simple family meals by Jenny",
    photo: "photo-1573496359142-b8d87734a5a2",
    item: "Weekly meal planner",
    options: [
      { label: "1 week", price: "$27" },
      { label: "5 weeks", price: "$39" },
    ],
    // The one of the five that can be opened: the live demo store, with the
    // one link it really has (lib/demo-seed.ts).
    links: ["Open a store like this one"],
    tint: "#9a4a33",
  },
  {
    handle: "mornpractice",
    name: "Morning Practice",
    line: "Mobility and strength by Ada",
    photo: "photo-1494790108377-be9c29b29330",
    item: "30-day mobility plan",
    options: [
      { label: "The plan", price: "$34" },
      { label: "Plan + 2 calls", price: "$89" },
    ],
    links: ["Free hip routine", "Book a session"],
    tint: "#1f6b53",
  },
  {
    handle: "lightandgrain",
    name: "Light & Grain",
    line: "Film presets by Thea",
    photo: "photo-1573497019940-1c28c88b4f3e",
    item: "Golden hour pack",
    options: [
      { label: "12 presets", price: "$24" },
      { label: "Everything", price: "$59" },
    ],
    links: ["Before and after", "How I shoot"],
    tint: "#8a6a1f",
  },
  {
    handle: "thequietdesk",
    name: "The Quiet Desk",
    line: "Study systems by Maren",
    photo: "photo-1484863137850-59afcfe05386",
    item: "Focus course",
    options: [
      { label: "The course", price: "$49" },
      { label: "Course + templates", price: "$69" },
    ],
    links: ["Free first lesson", "Student results"],
    tint: "#4946a6",
  },
  {
    handle: "saltandsteel",
    name: "Salt & Steel",
    line: "Knife skills by Dina",
    photo: "photo-1580894732444-8ecded7900cd",
    item: "Sharpening masterclass",
    options: [
      { label: "Masterclass", price: "$39" },
      { label: "With the live Q&A", price: "$79" },
    ],
    links: ["Free knife guide", "Watch a clip"],
    tint: "#8d3352",
  },
] as const;

const FACE = (id: string, s = 96) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&crop=faces&w=${s}&h=${s}&q=70`;

export function HeroFlow() {
  const [store, setStore] = useState(0);
  const [picked, setPicked] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const reduce = useSyncExternalStore(
    subscribeReduce,
    () => window.matchMedia(REDUCE).matches,
    () => false,
  );

  useEffect(() => {
    const node = root.current;
    if (!node || !("IntersectionObserver" in window)) return;
    let inView = false;
    const update = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    observer.observe(node);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  /*
   * One store at a time, changing every five seconds.
   *
   * This used to be a three-step animation of a whole sale — the store,
   * then Stripe's checkout, then the file delivered, then a bar showing
   * what the platform took, with buttons to step through it. Five
   * objects, and the section immediately below this one draws the same
   * sale properly in five steps. A first screen that explains the
   * mechanism is a first screen that has given up on being looked at.
   *
   * What is left is the thing being sold: a creator's store, real enough
   * to read, changing often enough that nobody sees the same one twice.
   *
   * Five seconds is long enough to read the name, the product and both
   * prices without hurrying. It stops entirely for anyone who has asked
   * motion to stop; they see the first store, which is the one the rest
   * of the page talks about.
   */
  useEffect(() => {
    if (reduce || picked || !visible) return;
    const t = setInterval(() => setStore((s) => (s + 1) % STORES.length), 5000);
    return () => clearInterval(t);
  }, [reduce, picked, visible]);

  /*
   * Choosing a store stops the rotation for good. Somebody who has just
   * pressed a face wants to read that store, not watch it be replaced
   * four seconds later.
   */
  const pick = (i: number) => {
    setStore(i);
    setPicked(true);
  };

  const s = STORES[store];

  return (
    <div ref={root} className="relative mx-auto w-full max-w-[32rem]">
      <div className="relative mx-auto w-[17rem] sm:w-[19rem]">
        {/*
          The light the phone sits in. One soft source behind it, the
          colour of the store currently on screen, so the whole
          composition changes temperature with the store rather than
          sitting on a fixed violet.
        */}
        <div
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 -z-10 h-[115%] w-[135%] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl transition-colors duration-[1200ms]"
          style={{ background: `radial-gradient(closest-side, ${s.tint}55, transparent)` }}
        />

        <div className="device">
          <div className="device-screen">
            <div className="flex items-center justify-between px-4 pb-1 pt-2.5 text-[10px] font-semibold text-ink-mute">
              <span>9:41</span>
              <span className="rounded-[5px] bg-white px-1.5 py-0.5 text-[9px] text-ink-soft ring-1 ring-line">
                {`marktmorgen.com/@${s.handle}`}
              </span>
            </div>
            {/*
              The key is the store's own, so React replaces the subtree
              rather than editing it and the fade runs again from the top.
            */}
            <div key={s.handle} className="nb-swap px-4 pb-5 pt-2">
              <div className="flex items-center gap-3">
                {/* A photograph served at the sizes asked for by its own host, never through the image optimizer, which is billed per image. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={FACE(s.photo, 112)}
                  alt=""
                  width={44}
                  height={44}
                  fetchPriority="high"
                  className="h-11 w-11 rounded-full bg-sand-deep object-cover ring-2 ring-white"
                  style={{ boxShadow: `0 0 0 3px ${s.tint}33` }}
                />
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold leading-tight text-ink">{s.name}</p>
                  <p className="truncate text-[11px] text-ink-mute">{s.line}</p>
                </div>
              </div>
              <div className="mt-3.5 rounded-[12px] border border-line bg-white p-3">
                <p className="text-[12px] font-semibold text-ink">
                  {s.item}
                </p>
                <div className="mt-2.5 grid gap-1.5">
                  <div className="flex items-center justify-between rounded-[9px] border border-line px-3 py-2 text-[12px]">
                    <span className="text-ink-soft">{s.options[0].label}</span>
                    <span className="font-semibold text-ink">{s.options[0].price}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-[9px] border border-violet-brand bg-lilac px-3 py-2 text-[12px]">
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-ink">
                      <span className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-violet-brand text-white">
                        <Icon name="check" size={9} strokeWidth={3} />
                      </span>
                      <span className="truncate">{s.options[1].label}</span>
                    </span>
                    <span className="font-semibold text-ink">{s.options[1].price}</span>
                  </div>
                </div>
                <div className="mt-3 rounded-[9px] bg-violet-brand py-2.5 text-center text-[12px] font-semibold text-white">
                  Continue with this option
                </div>
              </div>
              <div className="mt-2.5 grid gap-1.5">
                {s.links.map((l) => (
                  <p
                    key={l}
                    className="truncate rounded-[9px] border border-line bg-white px-3 py-2.5 text-[11.5px] font-medium text-ink-soft"
                  >
                    {l}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/*
          The other four stores, and a way to reach them.

          They used to be decoration: four portraits that drifted while
          the phone changed on its own every five seconds, which meant
          four of the five stores were invisible at any moment and nobody
          could go and look at one. A thing that plays at you is worse
          than a thing you can use.

          They are buttons now. Pressing one shows that store and stops
          the rotation, because somebody who has chosen should not have
          their choice taken away four seconds later.

          Only from 1024px up: below that the phone has the column to
          itself, and the row under it does this job instead.
        */}
        <div className="pointer-events-none absolute inset-y-0 -left-24 hidden w-24 lg:block">
          {STORES.map((o, i) => {
            const slot = ((i - store + STORES.length) % STORES.length) - 1;
            const spot = [
              { top: "6%", left: "8%", size: 58 },
              { top: "30%", left: "34%", size: 44 },
              { top: "54%", left: "4%", size: 50 },
              { top: "76%", left: "30%", size: 38 },
            ][slot];
            if (!spot) return null;
            const next = slot === 0;
            return (
              <button
                key={o.handle}
                type="button"
                onClick={() => pick(i)}
                title={`${o.name} — ${o.line}`}
                className="pointer-events-auto absolute block rounded-full transition-all duration-700 [transition-timing-function:var(--ease)] hover:scale-110 focus-visible:scale-110"
                style={{
                  top: spot.top,
                  left: spot.left,
                  width: spot.size,
                  height: spot.size,
                  opacity: next ? 1 : 0.55,
                  transform: next ? "scale(1.16) translateY(-6px)" : undefined,
                  boxShadow: `0 0 0 2px rgba(255,255,255,${next ? 0.9 : 0.35}), 0 12px 28px -8px ${o.tint}aa`,
                }}
              >
                <span className="sr-only">{`Show ${o.name}`}</span>
                {/* A photograph served at the sizes asked for by its own host, never through the image optimizer, which is billed per image. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={FACE(o.photo, 128)}
                  alt=""
                  width={spot.size}
                  height={spot.size}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full rounded-full object-cover"
                />
              </button>
            );
          })}
        </div>
      </div>

      {/*
        The same five, as a row, for every width where the portraits
        beside the phone do not fit. Five dots is not a decoration here:
        it is the only way a visitor on a phone can see that there is
        more than one store and go to the one that looks like theirs.
      */}
      <ul className="mt-6 flex items-center justify-center gap-2.5 lg:hidden">
        {STORES.map((o, i) => (
          <li key={o.handle}>
            <button
              type="button"
              onClick={() => pick(i)}
              aria-current={i === store}
              className="grid h-11 w-11 place-items-center rounded-full"
            >
              <span className="sr-only">{`Show ${o.name}`}</span>
              <span
                aria-hidden="true"
                className="block rounded-full transition-all duration-500"
                style={{
                  width: i === store ? 11 : 7,
                  height: i === store ? 11 : 7,
                  background: i === store ? o.tint : "rgba(255,255,255,0.4)",
                }}
              />
            </button>
          </li>
        ))}
      </ul>

      {/*
        One line, said once. What the picture is, and that the people in
        it are not customers of ours.
      */}
      <p className="mt-7 text-center text-[0.8125rem] leading-relaxed text-white/65">
        Five example stores we built. The photographs are licensed stock, not customers of ours. The{" "}
        <Link prefetch={false} href="/demo" className="font-medium text-white/85 underline underline-offset-4 decoration-white/30 hover:decoration-white">
          demo store
        </Link>{" "}
        is the one you can buy from, with a test card.
      </p>
    </div>
  );
}

