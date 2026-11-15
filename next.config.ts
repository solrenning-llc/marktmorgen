import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { staticPolicy } from "./lib/csp";

const nextConfig: NextConfig = {
  /**
   * Whether this build runs on the host whose browser check the server reads
   * (lib/bot-check.ts, browserProof: only when VERCEL is "1"). The client
   * starts the check only then (lib/browser-check-client.ts): anywhere else
   * its challenge script costs the visitor main-thread time for an answer
   * nobody reads (TODOS-100).
   */
  env: { NEXT_PUBLIC_BROWSER_CHECK: process.env.VERCEL === "1" ? "1" : "0" },
  /**
   * The letters a certificate's PDF is drawn with (lib/certificate-pdf.ts),
   * read from disk by the one route that needs them, so only its function
   * carries them.
   */
  outputFileTracingIncludes: {
    "/\\[handle\\]/certificate/\\[id\\]/pdf": ["./lib/fonts/**/*"],
    "/**/certificate/**": ["./lib/fonts/**/*"],
  },
  experimental: {
    /**
     * Put the stylesheet inside the HTML instead of in a separate file.
     *
     * The browser cannot paint a single word until it has the CSS, so that
     * separate file sits in front of everything. Measured on the live page,
     * on a phone on a slow connection, it costs 190 ms of pure waiting, and
     * Google's own report names it the one render-blocking request and says
     * to inline it. Inlining removes the request; the stylesheet now travels
     * inside the response that was already on its way.
     *
     * Do not judge this change on a local run: localhost has no latency, so
     * the round trip it removes costs nothing there and only the extra bytes
     * show up. It is measured in production.
     */
    inlineCss: true,
    /**
     * Off: guessing a link's route from links already prefetched.
     *
     * With it on (Next 16's default), a store page with three or more product
     * pages linked predicted the third one's route, asked the server for its
     * head alone, and never accepted the answer: the browser repeated that one
     * request hundreds of times a second for as long as the store page stayed
     * open. Each link now has its route asked for once, as before, which on a
     * store page costs one small request per product and settles.
     */
    optimisticRouting: false,
  },

  /**
   * The addresses people type, pointed at the page they meant.
   *
   * Someone who has heard of us types marktmorgen.com/pricing, because that
   * is where pricing lives on every other site they have used. Until now all
   * of these answered with the not-found page, which is the worst possible
   * answer: the page exists, it is one scroll down the home page, and we sent
   * them away instead. Each entry below is a name a visitor, a link in someone
   * else's post, or an old bookmark might use, sent to the page that actually
   * answers it.
   *
   * These are permanent on purpose. They are aliases, not a temporary state,
   * so a search engine should fold them into the real address rather than
   * index a second copy of the same page.
   *
   * None of this can shadow a creator's store: a store lives at /@name, and
   * every address here is a plain word with no @ in front of it.
   */
  async redirects() {
    const to = (destination: string, ...sources: string[]) =>
      sources.map((source) => ({ source, destination, permanent: true }));

    // /pricing is now a real page. Only the older aliases redirect to it.
    return [
      ...to("/pricing", "/price", "/prices", "/plans"),
      ...to("/proof/comparisons", "/compare", "/comparison"),
      ...to("/proof/compare", "/vs-stan", "/stan", "/stan-store", "/alternatives"),
      ...to("/platform", "/features", "/feature", "/product"),
      ...to("/platform/license-keys", "/platform/licence-keys"),
      ...to("/platform/switching-to-marktmorgen", "/platform/switching-to-nimbus"),
      ...to("/blog/how-marktmorgen-compares-with-stan", "/blog/how-nimbus-compares-with-stan"),
      ...to("/mission", "/about", "/about-us", "/founder", "/company"),
      ...to("/help", "/support", "/contact", "/docs", "/help-center", "/faq"),
      ...to(
        "/signin",
        "/login",
        "/log-in",
        "/sign-in",
        "/signup",
        "/sign-up",
        "/register",
        "/start",
        "/get-started",
        "/join",
      ),
      ...to("/studio", "/app", "/dashboard", "/account", "/settings"),
      ...to("/blog", "/journal", "/articles", "/posts", "/news"),
      ...to("/creators", "/creator"),
      // The demo's own thanks and recover pages are gone with the page they
      // belonged to: the demo is a store now, with a store's own (lib/house-store.ts).
      ...to("/demo", "/demo-store", "/example", "/preview", "/demo/thanks", "/demo/recover"),
      ...to("/terms", "/terms-of-service", "/tos"),
      ...to("/privacy", "/privacy-policy"),
      ...to("/refunds", "/refund", "/refund-policy"),
      // The security page lives among the feature pages, where security.txt points (508 [SG4]).
      ...to("/platform/security", "/security"),
      ...to("/", "/home", "/index"),
    ];
  },

  /**
   * Headers every response carries, marketing pages included.
   *
   * Set here rather than in proxy.ts on purpose: a page Next has prerendered
   * is served straight from Vercel's edge cache without the proxy running, so
   * headers added there reach the studio and the store pages and quietly miss
   * the home page. This list reaches all of them.
   *
   * The Content-Security-Policy here is the one for pages built ahead of
   * time (lib/csp.ts explains both). The pages rendered for each visit — the
   * stores, the studio — are given a stricter one with a fresh nonce by
   * proxy.ts, which replaces this one on those responses. Its frame-ancestors
   * is the rule that matters most: without it anyone can put the studio
   * inside an invisible frame on their own site and collect a signed-in
   * creator's clicks on buttons they never meant to press. 'self' is used
   * rather than 'none' so that a page of ours may still show another of
   * ours, as the home page once showed the demo store; X-Frame-Options says
   * the same to browsers that predate the policy.
   *
   * Strict-Transport-Security deliberately has no includeSubDomains: these
   * pages are also served on creators' own domains, and on theirs it would
   * force https on every other subdomain they run, which is not ours to
   * decide.
   *
   * Cross-Origin-Opener-Policy keeps a page opened from ours (or ours opened
   * from elsewhere) from holding a handle on the other window. Stripe is
   * reached by a redirect, never a popup, so nothing needs that handle.
   */
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), browsing-topics=()",
      },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Strict-Transport-Security", value: "max-age=63072000" },
    ];
    return [
      {
        // Every address but the card creators paste into their own sites.
        source: "/((?!embed/).*)",
        headers: [
          { key: "Content-Security-Policy", value: staticPolicy() },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          ...common,
        ],
      },
      /*
       * That card (lib/embed-rules.ts) is framed by other sites on purpose,
       * so it is sent without X-Frame-Options, which can only name this
       * site. Its Content-Security-Policy, which says any site may frame it
       * and nothing more, is written per visit by proxy.ts (lib/csp.ts).
       */
      {
        source: "/embed/:path*",
        headers: common,
      },
      /*
       * Nothing the API answers is a page. A picture, a file, a calendar or a
       * piece of JSON may not run, fetch or be framed, even if a browser were
       * talked into opening one as a document.
       *
       * The routes set this on their files too, but a header named here is
       * applied by the routing layer and wins, so the page policy above would
       * quietly replace "this file may do nothing at all" with the rules for
       * a page. It is written again here, last, because a header set in two
       * places is decided by the one that comes last.
       */
      {
        source: "/api/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; sandbox; frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

/*
 * withBotId adds the two addresses the sign-in form's challenge is fetched
 * from, on this site's own name (lib/bot-check.ts), and nothing else.
 */
export default withBotId(nextConfig);
