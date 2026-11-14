import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Fraunces, Geist, Instrument_Serif, Nunito, Playfair_Display } from "next/font/google";
import "./globals.css";
import { SiteData } from "@/components/structured-data";
import { Toaster } from "@/components/toast";
import { SITE_URL } from "@/lib/site-url";
import { SITE_OG_IMAGE } from "@/lib/site-og";
import { REVEAL_ON, REVEAL_WATCH } from "@/lib/reveal-scripts";
import { feeWords } from "@/lib/fee-words";
import { PLANS_ON_SALE, PREVIEW_LINE, PREVIEW_LINK } from "@/lib/opening";
import { PreviewLineProvider } from "@/components/preview-line";

/* Optional font display avoids a late font swap shifting a cold mobile page.
   Creator-selected faces below retain their existing choices and behavior.
   Two faces, both served from our own domain so the page never waits on
   fonts.googleapis.com: Geist for everything a person reads or clicks, and an
   italic serif kept for one or two words in a headline. */
const geist = Geist({
  variable: "--font-body",
  subsets: ["latin"],
  display: "optional",
});

/* Not preloaded (9 October 2026): a creator's store pages never use it, and
   preloading it there sent every buyer two files (31 KB) the page then threw
   away. The pages that do use it ask for it with their first styles, and
   show the fallback until it comes. */
const accent = Instrument_Serif({
  variable: "--font-accent",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "optional",
  preload: false,
});

/* The letters a creator may pick for their own page (lib/store-look.ts,
   FONTS). Declared here so every store page can use them, but never
   preloaded: a browser downloads one only for a page that asks for it. */
const editorial = Fraunces({ variable: "--font-st-editorial", subsets: ["latin"], display: "swap", preload: false });
const elegant = Playfair_Display({ variable: "--font-st-elegant", subsets: ["latin"], display: "swap", preload: false });
const friendly = Nunito({ variable: "--font-st-friendly", subsets: ["latin"], display: "swap", preload: false });
const bold = Bricolage_Grotesque({ variable: "--font-st-bold", subsets: ["latin"], display: "swap", preload: false });
const STORE_FONTS = [editorial, elegant, friendly, bold].map((f) => f.variable).join(" ");

const SITE_TITLE = PLANS_ON_SALE
  ? "Marktmorgen — the link-in-bio store that pays into your own Stripe"
  : "Marktmorgen — prepare your creator store";
const SITE_DESCRIPTION = PLANS_ON_SALE
  ? "A storefront for creators selling digital products, courses, memberships and booked sessions. Payments are processed through your own Stripe account, and " + feeWords().takes
  : PREVIEW_LINE;

export const viewport: Viewport = {
  /*
   * The colour the phone paints its own chrome with: the status bar on
   * Android, and the area behind a translucent status bar on an iPhone
   * with the site installed. It was still the violet-black of the old
   * palette, so on a phone the browser framed the page in a colour the
   * page no longer uses.
   */
  themeColor: "#111827",
  /*
   * Required on an iPhone with a notch or a Dynamic Island. Without it
   * the page is letterboxed between the safe areas and `env(safe-area-inset-*)`
   * reports zero, so nothing can reach the full screen and nothing can
   * compensate for the parts of it that are covered.
   */
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "./" },
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  manifest: "/manifest.webmanifest",
  applicationName: "Marktmorgen",
  appleWebApp: {
    capable: true,
    title: "Marktmorgen",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  // Only the picture and the site here: a shared link to any page carries
  // that page's own title and description (its <title> and description),
  // never the home page's.
  openGraph: {
    type: "website",
    siteName: "Marktmorgen",
    locale: "en_US",
    images: [SITE_OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    images: [SITE_OG_IMAGE.url],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-reveal is set on <html> by the first script in the body, before
    // React loads (lib/reveal-scripts.ts); React is told that attribute is
    // expected, so it does not report the page as mismatched.
    <html
      lang="en-US"
      className={`${geist.variable} ${accent.variable} ${STORE_FONTS} h-full antialiased`}
      suppressHydrationWarning
    >
      {/*
        The photographs come from one other host, and a browser cannot start
        fetching from it until it has looked the name up, opened a connection
        and agreed a certificate — three round trips that only begin when the
        first <img> is read, deep into the page. Saying the name here starts
        that handshake while the HTML is still arriving, so the first picture
        lands sooner on the connection where it matters, which is a phone on
        mobile data. React lifts this into the head itself.
      */}
      <link rel="preconnect" href="https://images.unsplash.com" crossOrigin="" />
      <body className="min-h-full flex flex-col">
        {/*
          The switch that lets sections start hidden and rise into view.

          Everything with `.reveal` on it is at full opacity in the stylesheet
          until this line runs, and it only runs where the thing that brings
          those sections back exists: a browser with JavaScript and an
          IntersectionObserver, and a reader who has not asked for less
          motion. If the script never runs — JavaScript off, a crawler, a
          proxy that drops it, a bundle that fails — the page is simply all
          there. An animation is worth having; a page whose middle is blank
          because an animation did not start is not.

          It is a plain synchronous script as the first thing in the body, so
          it sets the attribute before the first paint and nothing flashes.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: REVEAL_ON,
          }}
        />
        {/* The preview line, decided here on the server, for the site menu (components/preview-line.tsx). */}
        <PreviewLineProvider value={PLANS_ON_SALE ? null : { line: PREVIEW_LINE, href: PREVIEW_LINK.href, label: PREVIEW_LINK.label }}>
          {children}
        </PreviewLineProvider>
        {/*
          And the thing that brings them back, at the end of the body.

          This used to be a React effect, which meant the sections were
          hidden at first paint and uncovered only once the bundle had
          downloaded, parsed and hydrated. On a good connection that gap is
          invisible. On a phone on mobile data it is seconds of a page with
          a header and nothing under it — the visitor is looking at the
          blank middle the comment above says must never happen, and the
          cause is the animation itself.

          So the observer starts here instead, as plain script at the end of
          the body: it runs the moment the HTML is parsed, before any bundle
          is asked for, and it is not waiting on React to be alive. Anything
          already on screen is shown at once — a visitor who has not scrolled
          has not scrolled to it — and only what is still below the fold is
          left for the observer. If any of it throws, the attribute comes
          off and the whole page is simply there.

          The React component on each page does the same work again on a
          client-side navigation, where no script in this file runs a second
          time. Adding the class twice costs nothing.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: REVEAL_WATCH,
          }}
        />
        <Toaster />
        <SiteData />
      </body>
    </html>
  );
}
