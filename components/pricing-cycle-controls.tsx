"use client";

import { useState, type MouseEvent } from "react";

export function PricingCycleControls({ saving }: { saving: string }) {
 const [yearly, setYearly] = useState(false);
 function select(event: MouseEvent<HTMLButtonElement>, next: boolean) {
  const root = event.currentTarget.closest("[data-pricing-cycle]");
  if (!root || next === yearly) return;
  // These are server-owned static slots, not React-rendered client children.
  // Update only the small cycle-dependent values; never replace a card or
  // disclosure, so focus and the native open state survive billing changes.
  root.querySelectorAll<HTMLElement>("[data-cycle-text]").forEach(slot => {
   slot.textContent = (next ? slot.dataset.year : slot.dataset.month) ?? "";
  });
  root.querySelectorAll<HTMLAnchorElement>("[data-cycle-link]").forEach(link => {
   const tier = link.dataset.tier;
   if (tier === "creator" || tier === "pro" || tier === "scale") {
    link.href = `/signin?plan=${tier}&billing=${next ? "year" : "month"}`;
   }
  });
  root.querySelectorAll<HTMLElement>("[data-cycle-terms]").forEach(terms => {
   const template = terms.nextElementSibling;
   const selected = next ? template?.nextElementSibling : template;
   if (selected instanceof HTMLTemplateElement) {
    terms.replaceChildren(selected.content.cloneNode(true));
   }
  });
  setYearly(next);
 }
 return <div className="mb-6 flex flex-col items-center gap-2">
  <div className="seg" role="group" aria-label="How often you pay">
   <button type="button" className="seg-item" aria-pressed={!yearly} onClick={event => select(event, false)}>Monthly</button>
   <button type="button" className="seg-item" aria-pressed={yearly} onClick={event => select(event, true)}>
    Yearly <span className="rounded-full bg-mint-soft px-2 py-0.5 text-[0.75rem] font-semibold text-ink">{`two months free, up to ${saving}`}</span>
   </button>
  </div>
  <p className="text-sm text-ink-mute">Every plan either way, and you can switch from your studio whenever you like.</p>
 </div>;
}
