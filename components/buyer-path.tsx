"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { InstallApp } from "@/components/install-app";

/**
 * A sale, from the link in a bio to the money in the creator's account, as one
 * large screen and five numbered steps.
 *
 * Nothing moves by itself: the visitor picks a step, or presses Next. Every
 * screen is drawn from the live demo store, with its own words and prices, and
 * the section says so rather than calling a drawing a screenshot. The demo
 * is an ordinary store (lib/house-store.ts), so these are the store page,
 * the product card and the thanks page every creator's store has; when the
 * words on those change, the words here change with them.
 */
const PHOTO = (id: string, w: number, h: number, faces = true) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop${faces ? "&crop=faces" : ""}&w=${w}&h=${h}&q=68`;
const JENNY = "photo-1613666517563-d19a4585d1fe";
/*
 * The picture on the product card. The store page has no banner across its
 * top — a creator's store never had one; only the demo's old page did — so
 * there is one photograph here beside the portrait, and no second.
 */
const PRODUCT = "photo-1556908153-1055164fe2df";

type Step = { key: string; icon: IconName; title: string; caption: string };

const STEPS: Step[] = [
  { key: "store", icon: "store", title: "The store", caption: "The link in the bio opens the creator's face, a line about them, and everything they sell." },
  { key: "choose", icon: "tag", title: "Two sizes, two prices", caption: "One product, two prices. The buyer picks, and the button follows." },
  // Not "in the buyer's currency". Since 22 September the checkout charges in
  // the currency the price was written in, so that line was describing
  // behaviour the site no longer has.
  { key: "pay", icon: "card", title: "Paid on Stripe", caption: "Stripe's own checkout, on the creator's own account, at the price on the page." },
  { key: "file", icon: "download", title: "Delivered", caption: "As soon as Stripe confirms the payment, the file is on the screen. Lost later? The buyer gets it back by email." },
  { key: "money", icon: "bank", title: "In your Stripe", caption: "The sale sits in the creator's own Stripe dashboard. The plan's published sales fee and Stripe processing fees apply." },
];

function Screen({ step }: { step: string }) {
  switch (step) {
    case "store":
      return (
        <div className="px-5 pb-6 pt-7 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={PHOTO(JENNY, 144, 144)}
            alt="Jenny, the fictional cook of the demo store"
            width={144}
            height={144}
            loading="lazy"
            className="inline-block h-[4.5rem] w-[4.5rem] rounded-full bg-sand-deep object-cover ring-4 ring-paper"
          />
          <p className="mt-2 text-lg font-semibold text-ink">Harbor Kitchen</p>
          <p className="text-[12px] font-semibold text-ink-soft">@harborkitchen</p>
          <p className="mt-2 text-[13px] text-ink-soft">Simple family meals by Jenny, a fictional cook.</p>
          <div className="mt-5 space-y-2.5 text-left">
            <div className="overflow-hidden rounded-[14px] border border-line bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={PHOTO(PRODUCT, 560, 200, false)} alt="" width={560} height={200} loading="lazy" className="h-24 w-full bg-sand-deep object-cover" />
              <p className="flex items-center justify-between px-4 pt-3 text-[13px]">
                <span className="font-semibold text-ink">Weekly Meal Planner</span>
                <span className="font-semibold text-violet-deep">from $27</span>
              </p>
              <p className="px-4 pb-3 pt-1 text-[12px] leading-snug text-ink-soft">
                Simple family meal plans with breakfasts, lunches, dinners and a grocery list for each week.
              </p>
            </div>
            <p className="rounded-[12px] border border-line bg-white px-4 py-3 text-center text-[13px] font-semibold text-ink">
              Open a store like this one
              <span className="mt-0.5 block font-mono text-[11px] font-normal text-ink-soft">marktmorgen.com</span>
            </p>
          </div>
        </div>
      );
    case "choose":
      return (
        <div className="p-5">
          <div className="overflow-hidden rounded-[14px] border border-line bg-white">
            <div className="p-4">
              <p className="flex items-start justify-between gap-3">
                <span className="text-[15px] font-semibold text-ink">Weekly Meal Planner</span>
                <span className="shrink-0 rounded-full bg-lilac px-2.5 py-0.5 text-[12px] font-semibold text-violet-deep">from $27</span>
              </p>
              <p className="mt-1.5 text-[12.5px] leading-snug text-ink-soft">
                Simple family meal plans with breakfasts, lunches, dinners and a grocery list for each week.
              </p>
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between rounded-[12px] border border-line bg-white px-4 py-3">
                  <span className="flex items-center gap-2.5 text-[13px] font-semibold text-ink">
                    <span className="h-4 w-4 rounded-full border border-line-strong bg-white" />
                    1 week
                  </span>
                  <span className="text-[15px] font-semibold text-ink">$27</span>
                </div>
                <div className="flex items-center justify-between rounded-[12px] border-2 border-violet-brand bg-lilac px-4 py-3">
                  <span className="flex items-center gap-2.5 text-[13px] font-semibold text-ink">
                    <span className="grid h-4 w-4 place-items-center rounded-full border-2 border-violet-brand bg-white">
                      <span className="h-2 w-2 rounded-full bg-violet-brand" />
                    </span>
                    5 weeks
                  </span>
                  <span className="text-[15px] font-semibold text-violet-deep">$39</span>
                </div>
              </div>
              <p className="mt-4 rounded-[12px] bg-violet-brand px-4 py-3 text-center text-[14px] font-semibold text-white">Continue with this option</p>
            </div>
          </div>
          <p className="mt-3 rounded-[12px] border border-dashed border-line-strong px-4 py-3 text-[11.5px] leading-snug text-ink-soft">
            <span className="font-semibold text-ink">This is a demo store.</span> Its checkout runs in Stripe&apos;s test mode: no real money moves and no
            real card is charged.
          </p>
        </div>
      );
    case "pay":
      return (
        <div className="flex h-full flex-col bg-white p-5">
          <p className="text-[12px] text-ink-soft">Pay Harbor Kitchen</p>
          <p className="text-[2rem] font-semibold tracking-[-0.03em] text-ink">$39.00</p>
          <p className="text-[12px] text-ink-soft">Weekly Meal Planner (5 weeks)</p>
          <div className="mt-5 space-y-2">
            {["Email", "Card number", "MM / YY   ·   CVC", "Name on card"].map((f) => (
              <p key={f} className="rounded-[10px] border border-line px-3.5 py-2.5 text-[12.5px] text-ink-soft">
                {f}
              </p>
            ))}
          </div>
          <p className="mt-5 rounded-[10px] bg-ink px-4 py-3 text-center text-[14px] font-semibold text-white">Pay $39.00</p>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[11.5px] text-ink-soft">
            <Icon name="lock" size={12} />
            Card, Apple Pay, Google Pay and Link, handled by Stripe.
          </p>
        </div>
      );
    case "file":
      return (
        <div className="p-5">
          <div className="rounded-[16px] border border-line bg-white p-5">
            <span className="inline-block rounded-full bg-mint-soft px-2.5 py-0.5 text-[12px] font-semibold text-mint-text">Paid</span>
            <p className="mt-3 text-xl font-semibold text-ink">Thank you</p>
            <p className="mt-1.5 text-[13px] leading-snug text-ink-soft">
              You bought <span className="font-semibold text-ink">Weekly Meal Planner (5 weeks)</span> from Harbor Kitchen for $39.
            </p>
            <p className="mt-4 flex items-center justify-center gap-2 rounded-[12px] bg-violet-brand px-4 py-3 text-center text-[14px] font-semibold text-white">
              <Icon name="download" size={16} strokeWidth={2.2} /> Download it
            </p>
            <p className="mt-3 text-[11.5px] leading-snug text-ink-soft">
              This link works for about 72 more hours. After that it is not lost: type the address you paid with, and a new link is emailed to you.
            </p>
          </div>
          <p className="mt-4 text-[11.5px] font-semibold text-ink-soft">Three pages of the file</p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {["/demo/five-1.webp", "/demo/five-2.webp", "/demo/five-3.webp"].map((src) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={src} src={src} alt="" width={420} height={544} loading="lazy" className="h-24 w-full rounded-[8px] border border-line object-cover object-top" />
            ))}
          </div>
        </div>
      );
    default:
      return (
        <div className="p-5">
          <p className="text-[12px] font-semibold text-ink-soft">The creator&apos;s Stripe dashboard</p>
          <p className="mt-1 text-lg font-semibold text-ink">Payments</p>
          <div className="mt-4 rounded-[14px] border border-line bg-white">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span>
                <span className="block text-[15px] font-semibold text-ink">$39.00 USD</span>
                <span className="block text-[11.5px] text-ink-soft">Weekly Meal Planner (5 weeks)</span>
              </span>
              <span className="tag tag-live">Succeeded</span>
            </div>
            <dl className="divide-y divide-line text-[12.5px]">
              {[
                ["Charged on", "Harbor Kitchen's own account"],
                ["Platform fee", "None"],
                ["Stripe's fee", "Stripe's own published rate"],
                ["Paid out", "On the creator's Stripe schedule"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 px-4 py-2.5">
                  <dt className="text-ink-soft">{k}</dt>
                  <dd className="text-right font-medium text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <p className="mt-4 flex items-start gap-2 rounded-[12px] bg-lilac px-4 py-3 text-[12.5px] text-violet-ink">
            <Icon name="bank" size={16} className="mt-0.5 shrink-0" />
            Refunds, disputes and receipts live here too, in the creator&apos;s own name.
          </p>
        </div>
      );
  }
}

export function BuyerPath() {
  const [active, setActive] = useState(0);
  const base = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const step = STEPS[active];

  const go = (i: number, focus = false) => {
    const next = (i + STEPS.length) % STEPS.length;
    setActive(next);
    if (focus) tabs.current[next]?.focus();
  };

  /*
   * Warm paper, not white.
   *
   * The page runs on two light surfaces and nothing else — paper, then a
   * slightly warmer sand — so a reader can see where one part of it ends
   * without being told. A pure white band in the middle of that is a third
   * surface, and a third surface with no reason behind it is exactly the
   * randomness the two-surface system was put in to end. The white in this
   * section belongs to the device frames inside it, which is what white is
   * for here: the screen, not the page.
   */
  return (
    <section id="screens" className="surface-paper section scroll-mt-20 overflow-hidden">
      <div className="container-page">
        <div className="reveal flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div className="max-w-2xl">
            <h2 className="t-h2 balance">From the link in your bio to the money in your Stripe</h2>
            <p className="mt-5 text-ink-soft">
              Five steps, drawn from the live demo store with its own words and prices. Open it and buy with a Stripe test
              card to see each one for real.
            </p>
          </div>
          <Link href="/demo" prefetch={false} className="btn btn-secondary shrink-0">
            Open the demo store
            <Icon name="arrow-up-right" size={18} />
          </Link>
        </div>

        <div className="reveal mt-12 grid items-center gap-10 lg:grid-cols-[1fr_22rem] lg:gap-16 xl:grid-cols-[1fr_24rem]">
          <div
            role="tablist"
            aria-label="The steps of a sale"
            aria-orientation="vertical"
            /* min-w-0 is load-bearing: a grid item will not shrink below the
               width of its widest child unless it is told it may, and these
               tabs hold a line of whitespace-nowrap text. Without it the row
               refuses to shrink and the whole page grows a sideways scrollbar
               at 320px instead of scrolling inside this strip. */
            className="flex min-w-0 gap-2 overflow-x-auto pb-1 [scrollbar-width:none] lg:flex-col lg:overflow-visible lg:pb-0"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                e.preventDefault();
                go(active + 1, true);
              } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                e.preventDefault();
                go(active - 1, true);
              } else if (e.key === "Home") {
                e.preventDefault();
                go(0, true);
              } else if (e.key === "End") {
                e.preventDefault();
                go(STEPS.length - 1, true);
              }
            }}
          >
            {STEPS.map((s, i) => {
              const on = i === active;
              return (
                <button
                  key={s.key}
                  ref={(el) => {
                    tabs.current[i] = el;
                  }}
                  id={`${base}-tab-${s.key}`}
                  role="tab"
                  type="button"
                  aria-selected={on}
                  aria-controls={`${base}-panel`}
                  tabIndex={on ? 0 : -1}
                  onClick={() => go(i)}
                  className={`group flex shrink-0 items-start gap-4 rounded-[var(--r-lg)] border p-4 text-left transition-[background-color,border-color,box-shadow] duration-300 lg:p-5 ${
                    on
                      ? "border-violet-brand/40 bg-lilac/50 shadow-[var(--shadow-sm)]"
                      : "border-transparent hover:border-line hover:bg-paper"
                  }`}
                >
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold transition-colors duration-300 ${
                      on ? "bg-violet-brand text-white" : "bg-sand text-ink-soft group-hover:bg-sand-deep"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 whitespace-nowrap font-semibold text-ink">
                      <Icon name={s.icon} size={17} className={on ? "text-violet-deep" : "text-ink-mute"} />
                      {s.title}
                    </span>
                    <span className={`mt-1 hidden text-[0.9375rem] text-ink-soft lg:block ${on ? "" : "lg:line-clamp-1"}`}>{s.caption}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div
            id={`${base}-panel`}
            role="tabpanel"
            aria-labelledby={`${base}-tab-${step.key}`}
            className="mx-auto w-full max-w-[22rem]"
          >
            <figure>
              {/*
                On a wide screen this is a phone, because the point is that
                the store is a phone page. On a real phone the drawn frame
                would be a screen inside a screen at almost the same width, so
                `device-soft` takes the frame away below 640px and lets the
                interface fill the card instead.
              */}
              <div className="device device-soft">
                <div className="device-screen relative h-[34rem]">
                  <div className="flex items-center justify-between px-5 pb-1 pt-3 text-[11px] font-semibold text-ink-soft">
                    <span>9:41</span>
                    <span className="rounded-[6px] bg-white px-2 py-0.5 text-[10px] text-ink-soft ring-1 ring-line">
                      {step.key === "pay" ? "checkout.stripe.com" : step.key === "money" ? "dashboard.stripe.com" : "marktmorgen.com/@harborkitchen"}
                    </span>
                  </div>
                  <div key={step.key} className="nb-screen-in">
                    <Screen step={step.key} />
                  </div>
                </div>
              </div>
              <figcaption className="mt-5 text-center lg:hidden">
                <span className="block font-semibold text-ink">{`${active + 1}. ${step.title}`}</span>
                <span className="mt-1 block text-[0.9375rem] text-ink-soft">{step.caption}</span>
              </figcaption>
            </figure>
            <div className="mt-5 flex items-center justify-center gap-3">
              <button type="button" onClick={() => go(active - 1)} className="btn btn-ghost btn-sm" aria-label="Previous step">
                <Icon name="arrow-right" size={16} className="rotate-180" />
              </button>
              <span className="text-sm tabular-nums text-ink-soft" aria-live="polite">{`${active + 1} of ${STEPS.length}`}</span>
              <button type="button" onClick={() => go(active + 1)} className="btn btn-secondary btn-sm">
                {active === STEPS.length - 1 ? "Start again" : "Next step"}
                <Icon name="arrow-right" size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="container-page">
        <InstallApp />
      </div>
    </section>
  );
}
