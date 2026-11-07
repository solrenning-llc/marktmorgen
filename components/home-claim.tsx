"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- The home page's links are native anchors, as in app/page.tsx: no client prefetch on a page most visitors read and leave. */

import { useState } from "react";

/*
 * The store-address field of the home page (VS1), and the phone that shows
 * the address as it is typed.
 *
 * The form is a plain GET to the existing start page (app/signin), so it
 * works before this script loads. Nothing is reserved here: the start page
 * says the address back, and the address is taken on the address step after
 * the emailed link (components/handle-form.tsx, app/api/store/claim), where
 * the real rules decide.
 */

/** What the phone shows for what was typed: the existing rule's alphabet, lower case, at most 24. */
export function previewHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 24);
}

type Item = { title: string; kind: string; price: string };

export function ClaimForm({
  id,
  hintId,
  value,
  onValue,
}: {
  id: string;
  hintId: string;
  value?: string;
  onValue?: (value: string) => void;
}) {
  const [own, setOwn] = useState("");
  const current = value ?? own;
  return (
    <form action="/signin" method="get" className="hm-claim" data-home-claim>
      <label htmlFor={id} className="hm-sr">Pick your store address</label>
      <div className="hm-claim-field">
        <span aria-hidden="true" className="hm-claim-prefix">marktmorgen.com/@</span>
        <input
          id={id}
          name="handle"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={24}
          placeholder="yourname"
          aria-describedby={hintId}
          className="hm-claim-input"
          value={current}
          onChange={(event) => (onValue ? onValue(event.target.value) : setOwn(event.target.value))}
        />
      </div>
      <button type="submit" className="hm-claim-button">Claim it</button>
    </form>
  );
}

export function HeroClaim({ offer, items }: { offer: string; items: Item[] }) {
  const [typed, setTyped] = useState("");
  const handle = previewHandle(typed);
  const shown = handle || "yourname";
  return (
    <div className="hm-hero-grid">
      <div className="hm-hero-copy">
        <h1 id="home-hero-heading" className="hm-h1">Your link in bio, now a store.</h1>
        <p className="hm-hero-lead">Simple to set up, easy to run, and every sale goes straight to your own account.</p>
        <ClaimForm id="hm-handle" hintId="hm-claim-hint" value={typed} onValue={setTyped} />
        <p id="hm-claim-hint" className="hm-hero-offer" data-home-offer>{offer}</p>
      </div>

      <figure className="hm-hero-art">
        <div
          role="img"
          aria-label={`A phone previewing a store at marktmorgen.com/@${shown}, with the demo store's products`}
          className="hm-phone"
        >
          <div className="hm-phone-screen">
            <p className="hm-phone-url">{`marktmorgen.com/@${shown}`}</p>
            <div aria-hidden="true" className="hm-phone-cover" />
            <span className="hm-avatar">{shown.charAt(0).toUpperCase()}</span>
            <p className="hm-phone-name">{`@${shown}`}</p>
            <p className="hm-phone-note">Preview with demo products</p>
            <ul className="hm-phone-items">
              {items.map((item, i) => (
                <li key={item.title}>
                  <span aria-hidden="true" className={`hm-phone-thumb hm-thumb-${i}`} />
                  <span className="hm-grow">
                    <span className="hm-phone-title">{item.title}</span>
                    <span className="hm-phone-kind">{item.kind}</span>
                  </span>
                  <span className="hm-phone-price">{item.price}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="hm-hero-cards">
          <div className="hm-float hm-rise1 hm-float-a">
            <div className="hm-float-card hm-tilt-l">
              <span aria-hidden="true" className="hm-float-icon hm-bg-green">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 21h16" /></svg>
              </span>
              <span><strong>File delivered</strong><span>Once the payment clears</span></span>
            </div>
          </div>
          <div className="hm-float hm-rise2 hm-float-b">
            <div className="hm-float-card hm-tilt-r">
              <span aria-hidden="true" className="hm-float-icon hm-bg-gold">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="3" /><path d="M3 10h18M8 2v4M16 2v4" /></svg>
              </span>
              <span><strong>Call booked</strong><span>Invitation sent to you both</span></span>
            </div>
          </div>
          <div className="hm-float hm-rise3 hm-float-c">
            <div className="hm-float-card hm-float-stack hm-tilt-s">
              <span className="hm-float-label">Example course</span>
              <strong>Lesson 3 of 8 done</strong>
              <span aria-hidden="true" className="hm-bar"><span /></span>
            </div>
          </div>
        </div>

        <figcaption className="hm-hero-caption">
          The products are from our demo store. <a href="/demo">Open the demo store</a>
        </figcaption>
      </figure>
    </div>
  );
}
