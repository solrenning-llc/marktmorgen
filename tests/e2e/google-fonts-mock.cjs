/**
 * Google Fonts, as this machine sees them in the local end-to-end run: it
 * cannot reach fonts.googleapis.com, so next/font is given these answers
 * instead (NEXT_FONT_GOOGLE_MOCKED_RESPONSES, Next's own switch for tests).
 * One face per font, in the shape Google's CSS has, all drawn from the one
 * font file Next itself ships (its dev tools' Geist), served by the run's
 * stand-in services (tests/e2e/services.mjs) at E2E_FONT_ORIGIN.
 *
 * Keyed by the exact address next/font asks for, one per font in
 * app/layout.tsx and app/page.tsx. A font added there needs its line here: the build says
 * "url not found" until it has one. The address is what Next's own
 * getGoogleFontsUrl makes of the font's options.
 */
const FONTS = {
  "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=optional": ["Geist", "100 900", "optional"],
  "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital,wght@0,400;1,400&display=optional": ["Instrument Serif", "400", "optional"],
  "https://fonts.googleapis.com/css2?family=Figtree:wght@300..900&display=optional": ["Figtree", "300 900", "optional"],
  "https://fonts.googleapis.com/css2?family=Unbounded:wght@600;800&display=optional": ["Unbounded", "600 800", "optional"],
  "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap": ["Geist", "100 900"],
  "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital,wght@0,400;1,400&display=swap": ["Instrument Serif", "400"],
  "https://fonts.googleapis.com/css2?family=Fraunces:wght@100..900&display=swap": ["Fraunces", "100 900"],
  "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400..900&display=swap": ["Playfair Display", "400 900"],
  "https://fonts.googleapis.com/css2?family=Nunito:wght@200..1000&display=swap": ["Nunito", "200 1000"],
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@200..800&display=swap": ["Bricolage Grotesque", "200 800"],
};

const FILE = `${process.env.E2E_FONT_ORIGIN || "http://127.0.0.1:4477"}/fonts/mock.woff2`;

module.exports = Object.fromEntries(
  Object.entries(FONTS).map(([url, [family, weight, display = "swap"]]) => [
    url,
    `/* latin */
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: ${weight};
  font-display: ${display};
  src: url(${FILE}) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
`,
  ]),
);
