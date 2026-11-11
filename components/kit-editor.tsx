"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import { type Currency, fieldPrefix, moneyField } from "@/lib/money";
import {
  MAX_KIT_AUDIENCE,
  MAX_KIT_BRAND,
  MAX_KIT_BRANDS,
  MAX_KIT_FACT,
  MAX_KIT_FACTS,
  MAX_KIT_PITCH,
  MAX_KIT_RATES,
  MAX_KIT_RATE_TITLE,
  type StoreKit,
  kitShown,
} from "@/lib/store-kit";
import { SOCIALS, SOCIAL_NETWORKS, type SocialNetwork } from "@/lib/store-socials";
import { NewTab } from "@/components/new-tab";

type AudienceRow = { key: number; n: SocialNetwork; count: string; views: string };
type RateRow = { key: number; t: string; price: string };

const plain = (n: number) => (n > 0 ? String(n) : "");

/**
 * The media kit (lib/store-kit.ts) at /@handle/media-kit: what a brand reads
 * before paying for a post. Typed here, previewed on its own page once saved,
 * with the introduction drafted by AI from the store and the numbers given.
 */
export function KitEditor({
  kit,
  handle,
  currency,
  socials,
  ai,
  contact,
}: {
  kit: StoreKit;
  handle: string;
  currency: Currency;
  /** The networks the creator already lists under their name, offered first. */
  socials: SocialNetwork[];
  /** `known: false` when the allowance could not be read (lib/ai-on-value.ts): said so, never "0 left". */
  ai: { on: boolean; left: number; known?: false };
  /** Whether the store's contact form is on, which is how a brand gets in touch. */
  contact: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(kit.on);
  const [pitch, setPitch] = useState(kit.pitch);
  const [audience, setAudience] = useState<AudienceRow[]>(() => kit.audience.map((row, key) => ({ key, n: row.n, count: plain(row.count), views: plain(row.views) })));
  const [facts, setFacts] = useState(kit.facts.join("\n"));
  const [rates, setRates] = useState<RateRow[]>(() => kit.rates.map((rate, key) => ({ key, t: rate.t, price: rate.cents ? moneyField(rate.cents, currency) : "" })));
  const [brands, setBrands] = useState(kit.brands.join(", "));
  const [counted, setCounted] = useState(kit.counted);
  const [next, setNext] = useState(100);
  const [bad, setBad] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [left, setLeft] = useState<number | null>(ai.known === false ? null : ai.left);
  const [note, setNote] = useState("");

  const used = new Set(audience.map((row) => row.n));
  const offer = [...socials, ...SOCIAL_NETWORKS.filter((n) => !socials.includes(n))].filter((n, i, all) => all.indexOf(n) === i);
  const firstFree = () => offer.find((n) => !used.has(n)) ?? "website";
  const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  const payload = () => ({
    on,
    pitch,
    audience: audience.map(({ n, count, views }) => ({ n, count, views })),
    facts: lines(facts),
    rates: rates.filter((r) => r.t.trim()).map(({ t, price }) => ({ t, price })),
    brands: brands.split(/[,\n]/).map((b) => b.trim()).filter(Boolean),
    counted,
  });

  async function draft() {
    setDrafting(true);
    setNote("");
    setOptions([]);
    try {
      const { audience: rows, facts: said } = payload();
      const response = await fetch("/api/store/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "kit", audience: rows, facts: said, notes: "" }) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: string[]; left?: number; error?: string };
      if (data.ok && Array.isArray(data.value)) {
        setOptions(data.value);
        if (typeof data.left === "number") setLeft(data.left);
        return;
      }
      setNote(
        data.error === "used"
          ? "This month's writing help is used up. It starts again with your next billing month."
          : data.error === "notes"
            ? "Add a product, the line under your name or a number first, so there is something to write from."
            : "The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance.",
      );
    } catch {
      setNote("The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance.");
    } finally {
      setDrafting(false);
    }
  }

  async function save() {
    setSaving(true);
    setNote("");
    setBad([]);
    try {
      const response = await fetch("/api/store/kit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; bad?: string[] };
      if (data.ok) {
        toast(on ? "Media kit saved." : "Media kit saved, and kept off your store.");
        router.refresh();
        return;
      }
      if (data.error === "number") {
        setBad(data.bad ?? []);
        setNote("Some numbers could not be read. Write them plainly, like 12400 or 12.4k, and prices like 800.");
        return;
      }
      setNote("Something went wrong on our side. Nothing was changed. Try again in a moment.");
    } catch {
      setNote("Something went wrong on our side. Nothing was changed. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  const address = `/@${handle}/media-kit`;
  return (
    <section id="media-kit" aria-labelledby="kit-title" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
      <h2 id="kit-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Media kit</h2>
      <p className="mt-2 break-words text-ink-soft">
        A page for brands at marktmorgen.com{address}: who you are, your audience, what a collaboration costs and who you have
        worked with, in your store&apos;s look, with a button to save it as a PDF. The numbers are yours to type, and the page says so,
        with the day you last changed them. Beside them it shows what this site counted itself: your products, your buyers&apos;
        rating and, if you choose, your visitors, sales and buyers&apos; countries.
      </p>

      <label className="mt-5 flex items-start gap-3 text-ink">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="mt-1 size-5 shrink-0 accent-violet-brand" />
        <span className="font-semibold">Publish my media kit, with a link at the foot of my store page</span>
      </label>
      {on && !pitch.trim() && audience.length === 0 && rates.every((r) => !r.t.trim()) ? (
        <p className="mt-3 rounded-2xl bg-sand/60 px-4 py-3 text-sm text-ink">
          It goes live once it has an introduction, a number or an offer.
        </p>
      ) : null}
      {on && !contact ? (
        <p className="mt-3 rounded-2xl bg-sand/60 px-4 py-3 text-sm text-ink">
          Switch on the contact form on this page too, so a brand can reach you from the kit without your address being shown.
        </p>
      ) : null}

      <div className="mt-6">
        <label htmlFor="kit-pitch" className="field-label">Your introduction, to a brand</label>
        <textarea id="kit-pitch" rows={4} maxLength={MAX_KIT_PITCH} value={pitch} onChange={(e) => setPitch(e.target.value)} className="field mt-2" placeholder="I make weeknight recipes for busy parents. My audience cooks at home five nights a week and buys what I use." />
        {ai.on ? (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button type="button" onClick={draft} disabled={drafting || left === null} aria-busy={drafting} className="btn btn-secondary btn-sm">
              <Icon name="sparkle" size={16} />
              {drafting ? "Drafting…" : "Draft it with AI"}
            </button>
            <span className="text-sm text-ink-soft">{left === null ? "We could not check your AI allowance just now. Reload the page in a minute to try again." : `From what you sell and the numbers below, never others. ${left} drafts left this month.`}</span>
          </div>
        ) : null}
        {options.length ? (
          <ul className="mt-3 space-y-2" aria-label="Drafts">
            {options.map((option) => (
              <li key={option} className="rounded-2xl bg-paper p-3 ring-1 ring-line">
                <p className="text-sm text-ink">{option}</p>
                <button type="button" onClick={() => { setPitch(option); setOptions([]); }} className="mt-2 text-sm font-bold text-ink-soft underline underline-offset-4">
                  Use this one
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <fieldset className="mt-6">
        <legend className="field-label">Your audience</legend>
        <p className="mt-1 text-sm text-ink-soft">Followers, subscribers or monthly visitors, as your own dashboards show them today. Average views are optional.</p>
        <ul className="mt-3 space-y-2">
          {audience.map((row, i) => (
            <li key={row.key} className="grid gap-2 rounded-2xl bg-paper p-3 ring-1 ring-line sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
              <div>
                <label htmlFor={`kit-n-${row.key}`} className="text-xs font-semibold text-ink-soft">Where</label>
                <select id={`kit-n-${row.key}`} value={row.n} onChange={(e) => setAudience(audience.map((r) => (r.key === row.key ? { ...r, n: e.target.value as SocialNetwork } : r)))} className="field mt-1">
                  {offer.filter((n) => n === row.n || !used.has(n)).map((n) => (
                    <option key={n} value={n}>{n === "email" ? "Email list" : SOCIALS[n].label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`kit-count-${row.key}`} className="text-xs font-semibold text-ink-soft">How many</label>
                <input id={`kit-count-${row.key}`} inputMode="numeric" value={row.count} aria-invalid={bad.includes(`count${i}`) ? true : undefined} onChange={(e) => setAudience(audience.map((r) => (r.key === row.key ? { ...r, count: e.target.value } : r)))} className="field mt-1" placeholder="12.4k" />
              </div>
              <div>
                <label htmlFor={`kit-views-${row.key}`} className="text-xs font-semibold text-ink-soft">Average views (optional)</label>
                <input id={`kit-views-${row.key}`} inputMode="numeric" value={row.views} aria-invalid={bad.includes(`views${i}`) ? true : undefined} onChange={(e) => setAudience(audience.map((r) => (r.key === row.key ? { ...r, views: e.target.value } : r)))} className="field mt-1" />
              </div>
              <button type="button" onClick={() => setAudience(audience.filter((r) => r.key !== row.key))} className="text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger sm:pb-3">
                Remove
              </button>
            </li>
          ))}
        </ul>
        {audience.length < MAX_KIT_AUDIENCE ? (
          <button type="button" onClick={() => { setAudience([...audience, { key: next, n: firstFree(), count: "", views: "" }]); setNext(next + 1); }} className="btn btn-secondary btn-sm mt-3">
            <Icon name="plus" size={16} />
            Add a platform
          </button>
        ) : null}
      </fieldset>

      <div className="mt-6">
        <label htmlFor="kit-facts" className="field-label">About your audience (optional)</label>
        <textarea id="kit-facts" rows={3} value={facts} onChange={(e) => setFacts(e.target.value.split("\n").slice(0, MAX_KIT_FACTS).map((l) => l.slice(0, MAX_KIT_FACT)).join("\n"))} className="field mt-2" placeholder={"68% in the US\nMost are 25 to 34"} />
        <p className="mt-1 text-sm text-ink-soft">{`One line each, up to ${MAX_KIT_FACTS}, from your own dashboards.`}</p>
      </div>

      <fieldset className="mt-6">
        <legend className="field-label">What you offer brands (optional)</legend>
        <ul className="mt-3 space-y-2">
          {rates.map((rate, i) => (
            <li key={rate.key} className="grid gap-2 rounded-2xl bg-paper p-3 ring-1 ring-line sm:grid-cols-[2fr_1fr_auto] sm:items-end">
              <div>
                <label htmlFor={`kit-rate-${rate.key}`} className="text-xs font-semibold text-ink-soft">What</label>
                <input id={`kit-rate-${rate.key}`} maxLength={MAX_KIT_RATE_TITLE} value={rate.t} onChange={(e) => setRates(rates.map((r) => (r.key === rate.key ? { ...r, t: e.target.value } : r)))} className="field mt-1" placeholder="One Instagram Reel" />
              </div>
              <div>
                <label htmlFor={`kit-price-${rate.key}`} className="text-xs font-semibold text-ink-soft">{`Price, ${fieldPrefix(currency)} (empty: on request)`}</label>
                <input id={`kit-price-${rate.key}`} inputMode="decimal" value={rate.price} aria-invalid={bad.includes(`price${i}`) ? true : undefined} onChange={(e) => setRates(rates.map((r) => (r.key === rate.key ? { ...r, price: e.target.value } : r)))} className="field mt-1" />
              </div>
              <button type="button" onClick={() => setRates(rates.filter((r) => r.key !== rate.key))} className="text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger sm:pb-3">
                Remove
              </button>
            </li>
          ))}
        </ul>
        {rates.length < MAX_KIT_RATES ? (
          <button type="button" onClick={() => { setRates([...rates, { key: next, t: "", price: "" }]); setNext(next + 1); }} className="btn btn-secondary btn-sm mt-3">
            <Icon name="plus" size={16} />
            Add an offer
          </button>
        ) : null}
      </fieldset>

      <div className="mt-6">
        <label htmlFor="kit-brands" className="field-label">Brands you have worked with (optional)</label>
        <input id="kit-brands" value={brands} onChange={(e) => setBrands(e.target.value)} className="field mt-2" placeholder="Separated by commas" />
        <p className="mt-1 text-sm text-ink-soft">{`Up to ${MAX_KIT_BRANDS}, ${MAX_KIT_BRAND} characters each. Shown as plain names, never logos. Only brands you really worked with.`}</p>
      </div>

      <fieldset className="mt-6" data-kit-counted-editor>
        <legend className="field-label">Numbers this site counted (optional)</legend>
        <p className="mt-1 text-sm text-ink-soft">
          Counted here, not typed: visits to your store&apos;s pages, and sales and buyers&apos; countries from the payments on your own Stripe
          account. Read once a day, and the page says the day and where each number comes from.
        </p>
        <div className="mt-3 space-y-1">
          {(
            [
              ["visitors", "Visitors to my store, last 30 days"],
              ["sales", "Sales, last 30 days: the count, never the money"],
              ["countries", "My buyers' countries, as shares, last 90 days"],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="flex min-h-11 items-center gap-3 text-sm text-ink">
              <input type="checkbox" checked={counted[field]} onChange={(e) => setCounted({ ...counted, [field]: e.target.checked })} className="size-5 shrink-0 accent-violet-brand" />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {note ? <p className="mt-4 text-sm font-semibold text-ink" role="status">{note}</p> : null}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={saving} aria-busy={saving} className="btn btn-primary">
          {saving ? "Saving…" : "Save the media kit"}
        </button>
        {kitShown(kit) ? (
          <a href={address} target="_blank" rel="noopener" className="text-sm font-bold text-ink-soft underline underline-offset-4">
            Open it
          <NewTab /></a>
        ) : null}
      </div>
    </section>
  );
}
