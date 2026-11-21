/* eslint-disable @next/next/no-html-link-for-pages -- The short morning menu uses native anchors to avoid client link hydration, as the home page did; hrefs and keyboard paths are checked by the e2e tests. */
import { PLANS_ON_SALE, PREVIEW_LINE, PREVIEW_LINK } from "@/lib/opening";

/*
 * The top of a page in the morning look (VS1, queue item 571): the home
 * page's own menu, shared with /pricing so a visitor going from the home
 * page to the prices sees the same three choices in the same place
 * (WCAG 3.2.3, 3.2.6). Styled by app/home.css under `.hm`.
 */

/** The name's own picture, a sun coming up over a horizon, with the name beside it. */
export function MorningLogo() {
  return (
    <a href="/" className="hm-logo" aria-label="Marktmorgen, home">
      <span aria-hidden="true" className="hm-logo-mark">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 17a7 7 0 0 1 14 0" /><path d="M2 20h20" /><path d="M12 4v3" /><path d="M4.9 8.9l2.1 2.1" /><path d="M19.1 8.9L17 11" /></svg>
      </span>
      <span aria-hidden="true" className="hm-logo-word">Marktmorgen</span>
    </a>
  );
}

/**
 * The way past the menu, the line said while plans are not on sale
 * (lib/opening.ts), and the menu: Pricing, Log in and Start your store.
 * `current` marks the page the visitor is on (2.4.8).
 */
export function MorningHeader({ current }: { current?: "/pricing" }) {
  return (
    <>
      <a href="#content" className="hm-skip">Skip to the page content</a>
      {PLANS_ON_SALE ? null : (
        <div className="hm-topbar" data-preview-bar="">
          {/* Native disclosure: one complete notice, including without client code. */}
          <details className="hm-preview">
            <summary id="hm-preview-toggle" className="hm-preview-compact">Still being built. Plans closed.</summary>
            <p id="hm-preview-detail" className="hm-preview-full">
              {PREVIEW_LINE}{" "}
              <a href={PREVIEW_LINK.href}>{PREVIEW_LINK.label}</a>
            </p>
          </details>
        </div>
      )}
      <header className="hm-top">
        <div className="hm-wrap">
          <nav aria-label="Main" className="hm-nav">
            <MorningLogo />
            <ul className="hm-nav-links">
              <li><a href="/pricing" className="hm-nav-link" aria-current={current === "/pricing" ? "page" : undefined}>Pricing</a></li>
              <li><a href="/signin?to=login" className="hm-nav-link">Log in</a></li>
              <li><a href="/signin" className="hm-nav-cta">Start your store</a></li>
            </ul>
          </nav>
        </div>
      </header>
    </>
  );
}
