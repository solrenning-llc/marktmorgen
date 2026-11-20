"use client";

import { useState } from "react";
import { NICHE_FIT, STARTER_GOALS, STARTER_GOAL_LABELS, STARTER_NICHES, STARTER_NICHE_LABELS, matchingStarters, type StarterCard, type StarterGoal, type StarterNiche } from "@/lib/funnel-starter-catalog";

export function FunnelStarterGallery({ starters, busy, onChoose, initialGoal = "all", initialNiche = "all" }: { starters: StarterCard[]; initialGoal?: StarterGoal | "all"; initialNiche?: StarterNiche | "all"; busy: boolean; onChoose: (id: string) => void }) {
  const [goal, setGoal] = useState<StarterGoal | "all">(initialGoal);
  const [query, setQuery] = useState("");
  const [niche, setNiche] = useState<StarterNiche | "all">(initialNiche);
  const [expanded, setExpanded] = useState<string | null>(null);
  const shown = matchingStarters(starters, goal, query, niche);

  return (
    <div id="campaign-starters" className="mt-5 scroll-mt-24 border-t border-line pt-4">
      <h3 className="font-semibold text-ink">Start with a campaign, with first words written</h3>
      <p className="mt-1 text-sm text-ink-soft">Choose your goal, inspect the journey, then match it to your own products. Everything is created as a draft for you to review.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label htmlFor="starter-goal" className="block">
          <span className="field-label">What do you want to do?</span>
          <select id="starter-goal" className="field" value={goal} onChange={(event) => setGoal(event.target.value as StarterGoal | "all")}>
            <option value="all">All goals</option>
            {STARTER_GOALS.map((item) => <option key={item} value={item}>{STARTER_GOAL_LABELS[item]}</option>)}
          </select>
        </label>
        <label htmlFor="starter-niche" className="block">
          <span className="field-label">What kind of creator are you?</span>
          <select id="starter-niche" className="field" value={niche} onChange={(event) => setNiche(event.target.value as StarterNiche | "all")}>
            <option value="all">Any creator</option>
            {STARTER_NICHES.map((item) => <option key={item} value={item}>{STARTER_NICHE_LABELS[item]}</option>)}
          </select>
        </label>
        <label htmlFor="starter-search" className="block">
          <span className="field-label">Find a campaign</span>
          <input id="starter-search" type="search" className="field" maxLength={100} placeholder="Try course, guide or call" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      <p className="mt-3 text-xs text-ink-soft" role="status" aria-live="polite">{`${shown.length} of ${starters.length} campaigns shown`}</p>
      {shown.length ? (
        <ul className="mt-3 grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((starter) => {
            const open = expanded === starter.id;
            const detailsId = `starter-details-${starter.id}`;
            return (
              <li key={starter.id} className="min-w-0 rounded-2xl bg-white p-4 ring-1 ring-line">
                <p className="text-xs font-semibold text-violet-ink">{STARTER_GOAL_LABELS[starter.goal]}</p>
                <h4 className="mt-1 font-semibold text-ink">{starter.label}</h4>
                {niche !== "all" && NICHE_FIT[niche][starter.id] ? <p className="mt-2 text-sm font-semibold text-ink">{NICHE_FIT[niche][starter.id]}</p> : null}
                <p className="mt-2 text-sm text-ink-soft">{starter.hint}</p>
                <p className="mt-3 text-xs text-ink-mute">{`${starter.steps.length} steps · ${starter.pages} pages · ${starter.forms} ${starter.forms === 1 ? "form" : "forms"}`}</p>
                <button type="button" className="btn btn-ghost btn-sm mt-3" aria-expanded={open} aria-controls={detailsId} onClick={() => setExpanded(open ? null : starter.id)}>{open ? "Hide the journey" : "See the journey and what you need"}<span className="sr-only">{`: ${starter.label}`}</span></button>
                <div id={detailsId} hidden={!open}>
                  <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-soft">
                    {starter.steps.map((step, index) => <li key={`${step.kind}-${index}`}>{step.title}<span className="text-ink-mute">{step.kind === "product" ? " — your product" : " — page"}</span></li>)}
                  </ol>
                  <p className="mt-3 text-sm font-semibold text-ink">What you need</p>
                  {starter.products.length ? <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-soft">{starter.products.map((product, index) => <li key={index}>{product.label} ({product.wants})</li>)}</ul> : <p className="mt-1 text-sm text-ink-soft">No product needed. The application or sign-up form is included.</p>}
                  <p className="mt-2 text-xs text-ink-soft">{starter.forms ? "Forms arrive with no answers. " : ""}Fill in the parts in [brackets]. Review product choices and available room in the next preview before creating anything.</p>
                </div>
                <button type="button" className="btn btn-secondary btn-sm mt-3" disabled={busy} onClick={() => onChoose(starter.id)} aria-label={`Set up this campaign: ${starter.label}`}>Set up this campaign</button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-3 rounded-2xl bg-white p-4 ring-1 ring-line">
          <p className="text-sm text-ink-soft">No campaigns match these filters.</p>
          <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => { setGoal("all"); setQuery(""); setNiche("all"); }}>Show all campaigns</button>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-soft">Browsing and comparing campaigns does not use your AI or funnel preview allowance. Creating one uses your existing funnel, form and page allowances. Nothing publishes or sends an email here.</p>
    </div>
  );
}
