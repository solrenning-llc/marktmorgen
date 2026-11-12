# Speed and mobile comparison — measured, 6 November 2026 (queue item 38 [F7])

> **Internal study. Not for public use.** Nothing here may be used on a page, in an
> email, in an ad or in any comparison shown to customers. AX274 item 7 and VR item 7
> apply: no "faster than", "fastest" or any superiority claim without a complete,
> dated, reproducible measurement of every product compared, and none exists yet.
> This document records what was measured, how, and what could not be measured.

State (VR item 1): **document only**, in a branch. No product change, no customer-facing
change, no price, limit, commission, flag or gate touched.

## Result in one paragraph

Marktmorgen's own pages were measured on a local production build of `main` at
`5c0731550` (6 November 2026, 21:33–21:35 UTC, 18:33–18:35 Fortaleza) under throttled
mobile emulation: median Largest Contentful Paint between **1.10 s and 1.36 s**, Cumulative
Layout Shift **0.000–0.030**, **17–19 requests**, **368–484 KiB** transferred, of which
**208–266 KiB** JavaScript, and no horizontal scrolling at 320 or 412 CSS px. **No competitor
page could be measured**: every competitor host (and marktmorgen.com itself) was refused by
this sandbox's network policy. So there is **no comparison yet**, only Marktmorgen's own
baseline, and that baseline is a lab figure from localhost, not from production.

## Marktmorgen: results (median of 3 runs, cold cache)

Local production server (`next build` + `next start`), throttled as described under Method.
Times in milliseconds; sizes in KiB transferred over the wire (gzip, as `next start` serves).
LCP column shows the median and, in parentheses, the three runs.

| Page | FCP | LCP (runs) | CLS | TBT* | load event | Requests | Total KiB | JS KiB (files) | Font KiB | Image KiB | Overflow at 320 / 412 px |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| `/` (home) | 1180 | 1180 (1328, 1180, 1180) | 0.000 | 207 | 3398 | 17 | 461 | 231 (13) | 101 | 0 | 0 / 0 |
| `/pricing` | 1360 | 1360 (1272, 1364, 1360) | 0.000 | 196 | 3547 | 19 | 484 | 227 (13) | 101 | 0 | 0 / 0 |
| `/@harborkitchen` (demo store) † | 1136 | 1136 (1108, 1136, 1304) | 0.030 | 156 | 3075 | 17 | 411 | 265 (14) | 30 | 0 | 0 / 0 |
| `/@harborkitchen/p/weekly-meal-planner-373e6b5fac` (product page) † | 1096 | 1096 (1804, 1096, 1096) | 0.000 | 209 | 3161 | 17 | 413 | 266 (14) | 30 | 0 | 0 / 0 |
| `/for/coaches` ‡ | 1216 | 1216 (1156, 1216, 1680) | 0.000 | 246 | 2978 | 17 | 368 | 208 (11) | 30 | 0 | 0 / 0 |

\* TBT here is the sum of long-task time over 50 ms after First Contentful Paint until 3 s
after network idle, read from the browser's `longtask` entries. It is not Lighthouse's TBT
(which stops at Time to Interactive), so it is not comparable with Lighthouse reports.

† **Without the store's photos.** The demo store copies its Unsplash photos into storage the
first time it is set up (`lib/demo-seed.ts`); images.unsplash.com is blocked in this
sandbox, so locally the store rendered with no pictures. On marktmorgen.com the store and
product pages carry photos, so production transfers more bytes and the largest element may
be a picture rather than text. These two rows understate image weight and may understate LCP.

‡ **Two pictures failed to load** (images.unsplash.com refused by the network policy), so
image bytes are missing here too, and LCP is a text element that in production might be a
picture instead.

Other observations from the same runs:

- Every page sends a `<meta name="viewport">` and none scrolls sideways at 412 or 320 CSS px
  (`scrollWidth − clientWidth = 0`), consistent with WCAG 1.4.10 reflow at 320 px for the
  initial state. Other states (menus open, errors) were not checked.
- The largest contentful element was text (`H1` on the home page, `P` elsewhere) in every run.
- CLS on the demo store is 0.030 in all three runs: small, but the only page above zero.
  Its source was not investigated in this study.
- The extra failed requests counted on `/pricing` and `/for/coaches` are Next.js link
  prefetches (`/demo?_rsc=…`, `/signin?_rsc=…`) aborted when the run ended, not page errors.
- HTML is large before compression (home 727 KB raw, 131 KB gzip) because of the
  `inlineCss` experiment: CSS has no separate file (`CSS KiB` was 0 on every page) and is
  carried inside the HTML.
- Fonts: 101 KiB on the home and pricing pages, 30 KiB on the others.

## Competitors: could not be measured

Every attempt below was made from this sandbox on 6 November 2026 between 21:30:58 and
21:31:03 UTC with the same Chromium (153.0.8010.12). The sandbox's egress proxy refused the
connection (`net::ERR_TUNNEL_CONNECTION_FAILED`; `curl` showed `CONNECT tunnel failed,
response 403`). This is a policy refusal of the host, not a slow or broken site. Nothing was
estimated in its place.

| Product named in item 38 or in the brief | Host tried | Result |
| --- | --- | --- |
| Stan | https://stan.store/ | could not be measured (proxy refused, 403) |
| ClickFunnels | https://www.clickfunnels.com/ | could not be measured (proxy refused, 403) |
| Kajabi | https://kajabi.com/, https://www.mykajabi.com/ | could not be measured (proxy refused, 403) |
| Hotmart | https://hotmart.com/en, https://pay.hotmart.com/ | could not be measured (proxy refused, 403) |
| Gumroad | https://gumroad.com/ | could not be measured (proxy refused, 403) |
| Podia | https://podia.com/ | could not be measured (proxy refused, 403) |
| Shopify | https://www.shopify.com/ | could not be measured (proxy refused, 403) |
| Marktmorgen in production | https://marktmorgen.com/ | could not be measured (proxy refused, 403) |

Because the hosts themselves were refused, no specific public store or sales page of any
competitor (for example a public Stan Store or a Kajabi sales page) could be opened either.
No account was created, no login was attempted, no form was submitted.

Third-party measurement services were not used:

- webpagetest.org and pagespeed.web.dev: refused by the same proxy.
- The PageSpeed Insights API (www.googleapis.com) answered, but one keyless request to run it
  on a competitor page was refused by this session's permission policy, and a key would mean
  an account and a credential, which this item does not authorize. The Chrome UX Report API
  (real-user field data) also needs a key. Neither was pursued.

## Method

- **Build.** `git worktree` of `origin/main` at `5c0731550`; `node_modules` hard-linked from
  the main checkout (Turbopack refuses a `node_modules` symlink outside the project root);
  `next build` (Next.js 16.4.2, Turbopack). The first full build ran out of memory in
  TypeScript checking at Node's default heap; it passed with
  `NODE_OPTIONS=--max-old-space-size=6144` (compile 2.0 min, TypeScript 118 s, 504 static
  pages). Then `next start` on localhost.
- **Data.** Pages that read the database used a local, synthetic Upstash-compatible REST
  server backed by the repository's own in-memory test double (`lib/redis-memory.ts`),
  bundled with esbuild, on 127.0.0.1. The demo store was created by the real code path
  (`/demo` → `ensureDemoStore()` → redirect to `/@harborkitchen`). No real data, account,
  payment or email was involved.
- **Browser.** Playwright 1.63.0 with its bundled Chromium 153.0.8010.12, headless.
- **Device.** Mobile emulation: 412 × 823 CSS px viewport, device scale factor 1.75, touch,
  mobile user agent (Moto G Power class), as in Lighthouse's mobile profile.
- **Throttling.** CPU slowdown 4× (`Emulation.setCPUThrottlingRate`); network "Slow 4G" with
  Lighthouse's devtools-throttling values, 562.5 ms request latency, 1,474.56 kbit/s down,
  675 kbit/s up (`Network.emulateNetworkConditions`). Cache disabled; a new browser context
  for every run (cold cache, no cookies).
- **Metrics.** In the page: `PerformanceObserver` for `largest-contentful-paint`,
  `layout-shift` (without recent input) and `longtask`, registered before any page script
  ran; `first-contentful-paint` and navigation timing from the Performance API. Over CDP:
  every response's `encodedDataLength` (bytes on the wire) and resource type, giving total
  bytes, request count, JavaScript, font, image and stylesheet bytes. Reflow: the viewport
  was then set to 320 × 640 and `scrollWidth − clientWidth` read.
- **Runs.** Each page loaded 3 times in sequence; the table shows the median of each metric.
  Each run waited for `load`, then network idle (at most 30 s), then 3 s.
- **Control.** The home page loaded once without throttling (load event 0.70 s), once with
  the method above (3.52 s) and once with `Network.emulateNetworkConditionsByRule` (3.41 s),
  confirming the throttling took effect and that the two CDP methods agree.
- **Not reported: time to first byte.** Under this Chromium's network emulation the
  request latency does not show reliably in `responseStart` (it ranged from 11 to 507 ms
  across the 15 runs although 562.5 ms was set), so TTFB from these runs would be wrong and is left out.

### Raw data and script (traceability)

Measured commit: `main` at `5c07315505e1d53ee6401021601cd688fa98ecda`. Run window from the
run log: 2026-11-06T21:33:44Z to 2026-11-06T21:35:50Z. The raw results and the measuring
script are committed next to this document, byte-identical to the files used in the run:

| File | sha256 |
| --- | --- |
| `docs/speed-comparison-2026-11-06/results.json` (every run of every page, plus the Chromium version, network, CPU and device settings) | `4d6e6f74aa0d05bb03abd93f61df60f3a667f54fb820fd9ddcea20e9a56c8094` |
| `docs/speed-comparison-2026-11-06/measure.cjs.txt` (the script; stored as `.txt` so the repository's lint does not run on it, content unchanged) | `361f9127864368df7c2de2f2cb656d259422a62ae94f930b1b3e4552d2af244b` |

Check with `sha256sum docs/speed-comparison-2026-11-06/*`. To repeat: copy the script to
`measure.cjs` and run `node measure.cjs <out.json> <url> [url...]` with Playwright installed.
The synthetic database server used for the local build is not committed (it is a large
test double, not part of the measurement), so the figures remain author-reported local
measurements: the raw data lets anyone recompute the medians, but no one else has
re-run the measurement.

## What these numbers do not show

- **They are not production numbers.** Localhost has no internet round trip, no CDN, no
  Vercel edge, HTTP/1.1 instead of HTTP/2 or 3, and gzip instead of Brotli. Network latency
  was emulated per request, which is not the same as a real mobile network.
- **They are not field data.** No real visitors, no real devices, no Core Web Vitals from
  users.
- **Images are missing** on the store, product and `/for/coaches` pages, as noted above.
- **Interaction** (INP) was not measured: no tap or typing was simulated.
- **Only five pages**, all public. The studio, checkout, buyer area and course player were
  not measured.
- **A lab figure under one emulated profile** cannot be generalized to every phone or network.

## What would make the comparison possible

The same script, unchanged, run from a machine whose network reaches the competitor hosts
and marktmorgen.com, on the same day and under the same conditions, against: marktmorgen.com
(home, pricing, the demo store and one product page) and one comparable public page of each
competitor (a public Stan Store, a ClickFunnels and a Kajabi public sales page, a Hotmart
public sales page). Here that needs the owner either to allow those hosts in this cloud
environment's network settings or to run it elsewhere; both are the owner's decision and
nothing was changed. Even then, the results stay internal until AX274 item 7 and VR item 7
are met.

## Acessibilidade

Document only: no page, component, email or text shown to customers changed. Steps and
decisions of any task: 0 → 0. The study did record that the five pages measured have no
horizontal scroll at 320 CSS px in their initial state; that is an observation, not an
accessibility audit, and no assistive-technology testing was done.
