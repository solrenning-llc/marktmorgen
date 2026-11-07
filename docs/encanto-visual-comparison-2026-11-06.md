# Encanto: screen-by-screen visual comparison, Marktmorgen and Whop (6 November 2026)

## Resumo para o dono

Pedido: "meu site não encanta como a Whop". Comparamos seis telas nos dois sites em 06/11/2026, entre 07:19 e 07:30 UTC, em 1440×900 e 390×844, só navegando, sem conta, sem compra e sem formulário enviado.

- **Onde a Whop encanta mais:** vídeo e fotos grandes na home, imagens reais do produto em cada página de recurso, esqueletos de carregamento (23 na home, 8 na loja), modo escuro nas páginas de loja, de produto e de ajuda, prova social visível (nota, avaliações, "joined") e loja com cara de aplicativo (barra lateral, abas, capa).
- **Onde o Marktmorgen já é melhor:** é muito mais leve (17 a 41 requisições contra 327 a 761; 0,4 a 1 MB contra 1,4 a 7,2 MB), não tem salto de layout (CLS 0 em quase tudo), respeita 100% o "reduzir movimento" (a Whop mantém uma faixa de logos rolando nas páginas /network mesmo assim), não inventa números e tem uma prévia interativa do checkout que a Whop não tem.
- **O que mais falta, em ordem:** esqueletos e desfazer no estúdio (651), momentos de sucesso (654), loja do comprador mais bonita no computador e com menos texto repetido, modo escuro (o "Open work" do AX274 em docs/accessibility-programme.md cita os temas escuros; hoje há zero regras no CSS), imagens que aparecem borradas antes de carregar e no tamanho certo, uma identidade visual só no site público, conserto do mock da home e troca do "Start free".
- **Não capturado:** o checkout das duas (Marktmorgen vai para o Stripe, o que exige marcar a renúncia e enviar o formulário; a Whop pede login até para produto grátis) e o estúdio das duas (o Marktmorgen não tem estúdio de demonstração sem conta; as imagens do painel da Whop ficam em mintcdn.com, bloqueado pelo proxy).

Nada foi construído por este documento (regra VR). Preços e limites não mudam.

## Method

| Item | Value |
| --- | --- |
| Date | 2026-11-06. Marktmorgen captures 07:19:39Z to 07:22:47Z; Whop captures 07:22:31Z to 07:29:31Z (per-capture timestamps below). Exploratory navigation of public menus 07:05Z to 07:18Z. |
| Tool | Playwright Chromium through the session HTTPS proxy, deviceScaleFactor 1. Phone runs use an iPhone user agent, `isMobile` and touch. |
| Widths | 1440×900 (desktop) and 390×844 (phone). First-viewport and full-page PNG for each. |
| Per page | Motion on (`prefers-reduced-motion: no-preference`) and off (`reduce`): count of elements with a computed `animation-name`, running `document.getAnimations()`, transition count, motion libraries in scripts/HTML. Dark (`prefers-color-scheme: dark`): computed body background and a viewport capture. Slow network (390 only): CDP `Network.emulateNetworkConditions` with 2,000 ms latency and about 400 kbit/s each way, cache disabled, captures at 1 s, 4 s and 8 s, plus counts of skeleton-like elements (`[class*=skeleton]`, `shimmer`, `animate-pulse`, `aria-busy=true`). LCP and CLS from an in-page `PerformanceObserver` (buffered), measured after scrolling the whole page once. Requests and bytes from CDP `loadingFinished.encodedDataLength`. Largest images by transfer and by natural size, with the `loading` attribute. |
| Screenshots | Scratchpad only, never committed. Named `<site>-<screen>-<width>-<variant>.png`, variants `viewport`, `full`, `reduced-viewport`, `dark-viewport`, `slow1s`, `slow4s`, `slow8s`. 120 files. |
| Not done | No account, sign-in, purchase, form submission, consent tick, cookie acceptance or contact. |

### Fidelity limits (read before comparing numbers)

The proxy refused these hosts with HTTP 403 to CONNECT; I retried at 07:18:49Z, more than 30 s after the first refusal (07:16:58Z), and they were still refused: `d3gk2c5xim1je2.cloudfront.net`, `mintcdn.com`, `www.googletagmanager.com`. During the captures Chromium also failed to tunnel to `img-v2-prod.whop.com`, `assets-2-prod.whop.com`, `cdn.whop.com`, `stream.mux.com`, `segcdn.whop.com`, `ui-avatars.com` and several analytics hosts (Sentry, Cloudflare Insights, LinkedIn, Sardine, Claydar, t.whop.tw). Consequences:

- Whop store, product and checkout pages show broken image placeholders ("Profile picture" alt text, empty cover) and no product video. Real visitors see covers, avatars and videos there. Judge Whop's store layout, not its missing pictures.
- The Whop home hero video and customer-story videos (Mux) did not stream; a still frame or poster shows. The home "Power your platform" code previews say "The preview could not load", and 23 skeleton placeholders kept pulsing because their content never arrived.
- Whop request counts and bytes are lower bounds; Whop LCP on image-led pages is affected by proxy latency and refused hosts. Marktmorgen loaded every resource (only two of its own aborted prefetches).
- Marktmorgen is one origin (marktmorgen.com) for every request, so its numbers are complete.

## Screens chosen (found through each site's public menus)

| # | Screen | Marktmorgen | Whop |
| --- | --- | --- | --- |
| 1 | Home | https://marktmorgen.com/ | https://whop.com/ |
| 2 | Pricing | https://marktmorgen.com/pricing (header "Pricing") | https://whop.com/network/pricing/ (whop.com footer "About" → /sell/ redirects to /network/ → header "Pricing"; whop.com itself has no pricing link) |
| 3 | Feature page | https://marktmorgen.com/platform/checkout (Platform catalogue "Checkout tools") | https://whop.com/network/products/payments/ (header Products → "Payment acceptance") |
| 4 | Example store and product | https://marktmorgen.com/demo → redirects to /@harborkitchen ("Open the demo store" on the home page; the text is "Open the demo store", not "See the live demo"); product /@harborkitchen/p/grocery-list-pack-a4a9201338 | whop.com/discover now redirects to the home page (checked 07:08Z), so no public directory exists. Stores found via links on whop.com/blog posts: https://whop.com/savage-ecom/ (49 reviews, 299 joined) and its product /savage-ecom/products/savage-ecom/ |
| 5 | Checkout | Product page buy box (above). The next screen is Stripe-hosted: not captured | Free product https://whop.com/oses1620/products/oses1620/ ("Join for free"), found via /workforce/ on the blog. Clicking "Join"/"Join for free" opens a sign-in modal (email, Google, Apple, Discord): not captured beyond that |
| 6 | Studio / dashboard | No demo studio without an account: not captured | https://docs.whop.com/manage-your-business/manage-business/analytics. Its dashboard GIF is on mintcdn.com (blocked): the image is not captured, only the text |

## Measured numbers per pair

Normal network, motion allowed, light scheme. LCP in ms, CLS unitless, requests, transferred kB. Slow LCP is the 390 run under the slow profile.

| Screen | Site | Captured (UTC) | LCP 1440 | CLS 1440 | Req / kB 1440 | LCP 390 | CLS 390 | Req / kB 390 | Slow-network LCP 390 | Page height 1440 / 390 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Home | Marktmorgen | 07:19:39 / 07:20:06 | 1,080 (h1) | 0 | 17 / 406 | 548 (h1) | 0 | 17 / 406 | 2,996 | 4,741 / 7,311 |
| Home | Whop | 07:22:31 / 07:23:30 | 856 (h1) | 0.0003 | 397 / 7,179 | 3,248 (h1) | 0.0006 | 386 / 5,902 | none recorded by load (63 s) | 8,556 / 10,370 |
| Pricing | Marktmorgen | 07:21:03 / 07:21:42 | 876 (h1) | 0 | 35 / 800 | 384 (p) | 0 | 35 / 798 | 3,004 | 11,887 / 24,353 |
| Pricing | Whop | 07:22:57 / 07:23:54 | 16,808 (p, late text paint) | 0.0002 | 327 / 1,669 | 6,240 (h1) | 0 | 327 / 1,655 | 81,560 | 8,739 / 11,012 |
| Feature | Marktmorgen | 07:21:03 / 07:21:37 | 972 (h1) | 0 | 41 / 812 | 436 (p) | 0 | 30 / 597 | 2,908 | 8,342 / 14,222 |
| Feature | Whop | 07:23:40 / 07:24:34 | 10,936 (hero PNG) | 0.0183 | 341 / 5,789 | 8,932 (hero PNG) | 0 | 341 / 5,804 | 101,380 | 6,326 / 7,346 |
| Store | Marktmorgen | 07:21:03 / 07:21:34 | 2,820 (img; TTFB 1,861 cold) | 0.0082 | 26 / 794 | 568 (img) | 0.0287 | 26 / 794 | 13,084 | 4,675 / 5,249 |
| Store | Whop | 07:25:36 / 07:26:05 | 1,008 (text) | 0 | 761 / 1,481 | 920 (text) | 0 | 760 / 1,485 | 11,504 | app shell 900 / 844 |
| Product / checkout entry | Marktmorgen | 07:22:22 / 07:22:48 | 928 (img) | 0 | 22 / 1,003 | 968 (img) | 0 | 22 / 1,003 | 12,732 | 2,561 / 2,802 |
| Product | Whop | 07:26:49 / 07:27:20 | 1,436 (h1) | 0 | 581 / 1,468 | 1,304 (h1) | 0 | 580 / 1,429 | 11,256 | app shell |
| Checkout entry (free product) | Whop | 07:28:49 / 07:29:31 | 1,356 (h1) | 0.0002 | 575 / 2,018 | 1,120 (h1) | 0 | 575 / 2,026 | 11,180 | app shell |
| Studio (docs) | Whop | 07:27:26 / 07:27:52 | 1,060 (p) | 0.0001 | 95 / 2,559 | 640 (span) | 0 | 72 / 1,576 | 8,676 | 3,678 / 4,696 |
| Studio | Marktmorgen | not captured | | | | | | | | |

Reading: Marktmorgen is lighter by an order of magnitude in requests and, outside the product page, in bytes. Both are under the CLS 0.1 threshold everywhere. Marktmorgen's worst numbers are the cold store load (TTFB 1,861 ms at 1440) and slow-network LCP on image pages (about 13 s), which is the image-sizing gap below.

## Motion, dark mode, loading states and images

| Check | Marktmorgen | Whop |
| --- | --- | --- |
| Entrance animation, motion allowed | Home: `hm-rise` on 3 hero elements (700 ms translate, no opacity hiding). Store and product: `st-aurora` background and `st-spotlight` (store) running. Pricing and feature: none. | Home: `landing-hero-arrive`, `landing-marquee` (logo strip), `landing-autoplay-progress`, `whop-arcade-fade`, `fui-skeleton-pulse` ×23 (29 running). /network pages: `scroll-seamless` logo marquee. Store: `fui-skeleton-pulse` ×8. |
| Same pages with `reduce` | 0 running animations on every page. A global rule sets animation and transition durations to 1 ms (app/globals.css, reduce block), so transitions are effectively instant. | Home keeps 1 (`landing-autoplay-progress` at 1440, `landing-nav-cta-flag` at 390). Pricing and Payments keep the `scroll-seamless` logo marquee running under `reduce`. Store stops its skeleton pulse. |
| Motion library | None (CSS only; the scanner's "framer" hit is a false positive from class names). | CSS keyframes (87 to 103 per page); no GSAP/Lottie/Three detected; one canvas on the home page. |
| Hover/transitions | 18 to 72 elements with transitions (colors, borders, underline). | 104 to 177 on marketing pages, 7 on store/product. |
| Dark scheme | No `prefers-color-scheme: dark` rule anywhere (0 rules); body stays rgb(247,245,240) on every page. | Store, product and checkout switch to rgb(17,17,17) with light text. Docs switch, and offer a light/system/dark control. Marketing pages are fixed themes (home black, /network light) and do not change. |
| Skeletons on slow network | None. Home at 1 s shows the header only and an empty body; text arrives by about 3 s. Store at 4 s shows a half-painted photo above a flat beige box. | Home: 10 skeleton elements visible at 1 s. Store: 8 pulsing post skeletons. Docs: 54 skeleton elements at 1 s. |
| Image formats and size | Home, pricing, feature: 0 raster images (illustrations are CSS and SVG, 22 to 79 SVGs). Store/product: WebP. Product "More from Harbor Kitchen" thumbnails are 1200×675 WebP (116 to 202 kB each) displayed 56 px wide; avatar 480×480 displayed at 72 px. 3 of 5 images lazy on the product page, 1 of 5 on the store. | Home: 53 images, 51 lazy; mission photo is a 3072×4096 WebP of 3,349 kB displayed 576 px wide. Payments: 90 images, 0 lazy; hero PNG 1485×1485 (545 kB) at 598 px, testimonial PNGs of 1,507 kB and 697 kB. |

## Screen 1: Home

Files: `marktmorgen-home-1440-viewport.png`, `marktmorgen-home-1440-full.png`, `marktmorgen-home-390-viewport.png`, `marktmorgen-home-390-full.png`, `marktmorgen-home-390-slow1s.png`, `whop-home-1440-viewport.png`, `whop-home-1440-full.png`, `whop-home-390-viewport.png`, `whop-home-390-slow1s.png`.

| Aspect | Whop | Marktmorgen | Who is ahead |
| --- | --- | --- | --- |
| Visual hierarchy | One sentence ("The new economy."), one subline, one orange button, over a full-bleed video. Nothing else above the fold. | Strong: 92 px Unbounded headline, subline, name-claim field with "Claim it", phone mock on the right. Above the hero sits a full-width "still being built" banner (one line at 1440, three lines and about 85 px at 390). | Tie at 1440; Whop at 390, where Marktmorgen's banner and header push the mock below the fold. |
| Typography scale | h1 96 px / 72 px phone, Acid Grotesk 400, tight leading. | h1 92 px / 38 px phone, Unbounded 800. | Tie. |
| Imagery | Video hero, product UI cards (Payments, Ads, Trading, Accounts, Cards, Communication) that look like real screens, a gallery of business "blueprints" with live previews, customer-story video carousel, a large photo for the mission section, phone app with QR code. | No photos at all. CSS illustration: warm gradient, sun, phone mock with three floating cards. "What you can sell" cards hold small working UI samples (lesson checklist, time chips, monthly/yearly toggle, file row). | Whop for richness; Marktmorgen's sell-cards are already a delightful touch. |
| Defects | Code previews say "The preview could not load" here (blocked hosts), not representative. | The floating cards cover the phone mock and cut its text: the address reads "…tmorgen.com/@yourname" and the caption "Preview with demo pro…". It reads as unfinished. | Marktmorgen must fix. |
| Color and depth | Black page, orange accent, 76 shadowed elements (cards, mockups). | Navy, yellow and peach; 7 shadows, 6 gradients. | Whop has more depth; Marktmorgen is warmer. |
| Motion | Hero arrive animation, marquee, autoplay progress; mostly stops under `reduce`. | Three-step rise only when motion is allowed; nothing under `reduce`. | Whop more alive; Marktmorgen fully compliant. |
| Social proof | Logo strip (Replit, Polymarket, Cal.com, etc.), customer stories. The "Economic Intelligence" card list shows numbers ("Win back 240 members…") that are illustrative. | None, by design (no customers yet; VR forbids invented proof). Points to the live demo store instead. | Whop, but Marktmorgen must not copy it with invented numbers. |
| CTA wording | "Get started". | Header and pricing card say "Start free"; the Encanto rules forbid "free" as a call to action. Below the field: "Free to set up. When plans open: 14 days free, then $69 a month." (a factual sentence, not a button). | Marktmorgen must change the button text. |
| Speed | 397 requests, 7.2 MB, slow-network LCP not reached by load. | 17 requests, 406 kB, LCP 548 to 1,080 ms, CLS 0. | Marktmorgen. |
| Loading state | Skeletons at 1 s on slow network. | Header only, blank body at 1 s. | Whop. |

## Screen 2: Pricing

Files: `marktmorgen-pricing-1440-viewport.png`, `marktmorgen-pricing-1440-full.png`, `marktmorgen-pricing-390-full.png`, `whop-pricing-1440-viewport.png`, `whop-pricing-1440-full.png`, `whop-pricing-390-full.png`.

| Aspect | Whop | Marktmorgen | Who is ahead |
| --- | --- | --- | --- |
| Structure | Two cards (Standard "2.7% + $0.30", Custom), then "Transparent pricing, by category" with a sticky left index (Payments, Payouts, Fraud & Security, Revenue Optimization), each category a card with an icon and its fee rows; then local payment methods and financing providers as rows with colored brand icons; FAQ; logo strip; dark CTA band. 8,739 px. | Monthly/yearly switch, three plan cards (Store $69, Studio $449, Scale $999) with "Where to start" tag, then allowance tables per area, add-ons, a cost calculator, comparison, FAQ. 11,887 px desktop, 24,353 px phone. | Whop for scannability; Marktmorgen for completeness (every limit published). |
| Density | Rows are short; each category card has a summary checklist. | Long tables of limits with small text; on phone the page is about 29 screens tall. | Whop. |
| Color and depth | Light page, white cards, subtle shadows, colored payment logos give rhythm. | Same blue/yellow language as home; tables are flat. | Whop. |
| Motion | Logo marquee keeps running under `reduce`. | None. | Marktmorgen on compliance. |
| Speed | 327 requests, 1.7 MB; LCP 16.8 s at 1440 was a late text paint (unusual, likely blocked third parties). | 35 requests, 0.8 MB, LCP 384 to 876 ms. | Marktmorgen. |

## Screen 3: Feature page (checkout tools vs payments)

Files: `marktmorgen-feature-1440-viewport.png`, `marktmorgen-feature-1440-full.png`, `marktmorgen-feature-390-full.png`, `whop-feature-1440-viewport.png`, `whop-feature-1440-full.png`.

| Aspect | Whop | Marktmorgen | Who is ahead |
| --- | --- | --- | --- |
| Hero | "We built checkout for global scale", phone mock of a real-looking checkout (Apple Pay, Klarna, Splitit, card), logo strip under it. | "Earn more from every buyer, on the $69 plan" with an italic serif accent, status chips ("Working today", "All plans; limits apply"), and a working checkout preview: ticking "Add Recipe cards for $4" changes the button total. | Marktmorgen's interactive preview is a real micro-interaction Whop lacks. |
| Body | Alternating sections with large product images (816×612 feature PNGs), testimonials with photos, FAQ. 6,326 px. | 20 text cards in a two-column grid, "What keeps it honest", "What it does not do yet", FAQ, terms, related features. 0 images. 8,342 px desktop, 14,222 px phone. | Whop for imagery and rhythm; Marktmorgen for honesty. |
| Brand consistency | /network pages use a light system distinct from the black home page. | Different system from the home page: Geist font, indigo/purple buttons, purple gradient logo, full header with Product/Creators/Why menus; the home page uses Unbounded/Figtree, navy/yellow, a yellow logo tile and only "Pricing / Log in". | Both split; Marktmorgen's split sits in the main path (home → platform), so a visitor feels they changed sites. |
| Speed | 341 requests, 5.8 MB; hero PNG 545 kB, LCP about 9 to 11 s; 0 of 90 images lazy. | 30 to 41 requests, 0.6 to 0.8 MB, LCP 436 to 972 ms. | Marktmorgen. |

## Screen 4: Example store and product page

Files: `marktmorgen-store-1440-viewport.png`, `marktmorgen-store-1440-full.png`, `marktmorgen-store-390-viewport.png`, `marktmorgen-store-390-slow4s.png`, `marktmorgen-product-390-viewport.png`, `marktmorgen-product-1440-full.png`, `whop-store-1440-viewport.png`, `whop-store-390-dark-viewport.png`, `whop-product-1440-viewport.png`, `whop-product-1440-full.png`.

| Aspect | Whop | Marktmorgen | Who is ahead |
| --- | --- | --- | --- |
| Layout at 1440 | App shell: left sidebar (store switcher, Home, apps), centered column with cover banner, avatar, name, rating, "Join", tabs Home / Products / Reviews, feed. | One 540 px column centered on a warm background; 900 px of empty space on each side. | Whop. |
| Product cards | Product page: two columns, media carousel left, sticky purchase card right (price, "Get access", "Add to cart"), FAQ accordion, rating histogram (5.0, 49 ratings, bars per star), review cards with "Written 1 day after purchase". | Store cards with large food photography (good), price pill, option list, payment-plan choice. Each card repeats the 14-day withdrawal consent paragraph, its EU/UK note and the store-closing paragraph (about 90 words) above every Buy button; three times on the demo store. Product page has a sticky bottom bar on phone ("$5 · Buy for $5"), "Ask" question box, gift and team purchase. | Whop for calm; Marktmorgen for photography, sticky phone bar and buyer protections. |
| Social proof | Rating, review count, "299 joined", "Joined by X, Y and 4 others" with avatars. | None on the demo store (the store is fictional and has no real buyers; showing reviews would break VR). The platform has verified reviews (/platform/reviews). | Whop; Marktmorgen can only show real, verified reviews. |
| Empty state | "Looks like there aren't any posts yet. Be the first one to make a post!" over a faded skeleton post. | Not observable on the demo store (it has products). | Whop has a pattern. |
| Dark mode | Store and product turn dark with the system setting (`whop-store-390-dark-viewport.png`). | Stays light. | Whop. |
| Loading | 8 pulsing skeleton posts. | Photos paint progressively over a flat beige box (`marktmorgen-store-390-slow4s.png`). | Whop. |
| Images | Not comparable (blocked hosts). | WebP, but product thumbnails 1200×675 for a 56 px slot (116 to 202 kB each); slow-network LCP about 13 s. | Marktmorgen must resize. |
| Motion | None besides skeleton pulse. | Background aurora and spotlight when motion is allowed; none under `reduce`. | Tie. |

## Screen 5: Checkout

Files: `marktmorgen-product-1440-full.png` (buy box), `whop-checkout-1440-viewport.png`, `whop-checkout-390-viewport.png`.

| Aspect | Whop | Marktmorgen |
| --- | --- | --- |
| First screen reached | Free product page with "Join for free" and "Add to cart". Clicking "Join"/"Join for free" opened a sign-in modal (email, Google, Apple, Discord) during the exploratory probe (before 07:18Z); the scripted click at 07:28Z left the URL unchanged. | In-page buy box: option, payment plan, withdrawal-consent checkbox (`required`), "Buy for $5". The form posts to /api/store/checkout, which answers 303 to the creator's Stripe-hosted checkout. |
| Captured? | **Not captured**: sign-in required even for a free product. | **Not captured**: reaching it needs ticking the consent (accepting terms), submitting the form (which also opens a Stripe test session) and checkout.stripe.com, which is not on the allowed host list. |
| Success moment | Whop's docs describe a confirmation check in express checkout (queue 654 cites it); not observed here. | Not observed. From the code: the thank-you page does not animate; `@keyframes nb-draw` exists and is unused (queue 654). |

## Screen 6: Studio / dashboard

Files: `whop-studio-1440-viewport.png`, `whop-studio-1440-full.png`.

| Aspect | Whop | Marktmorgen |
| --- | --- | --- |
| Public material | Docs "Analytics": metric widgets you add, drag and arrange on the dashboard home. The demo GIF (analytics720p30fps.gif) is on mintcdn.com: blocked, so no image. The docs have their own light/system/dark switch and 54 skeleton elements on slow network. | No public demo studio; /studio requires sign-in. Public feature pages show no studio screenshots (0 images on /platform/checkout and /platform/path). |
| Captured? | Text only; dashboard image **not captured** (blocked host). | **Not captured** (no account-free demo). |
| Known from the repository | n/a | 0 `loading.tsx` files and no skeleton component (queue 651); first sale is a line of text in app/studio/page.tsx (queue 654). |

## Where Marktmorgen is already better

1. Speed and weight: 17 to 41 requests and 0.4 to 1.0 MB against 327 to 761 requests and 1.4 to 7.2 MB on Whop; LCP under 1.1 s on every non-store page at 1440.
2. Stability: CLS 0 on 8 of 10 runs; the worst is 0.0287 (store, phone). Whop's worst is 0.0183.
3. Reduced motion: every Marktmorgen animation stops; Whop's /network logo marquee keeps moving under `reduce`.
4. Honesty: no invented numbers, statuses on every feature ("Working today"), a "What it does not do yet" section.
5. Interactive explanation: the checkout preview on /platform/checkout updates its total when you tick the add-on.
6. Image weight on marketing pages: zero raster bytes on home, pricing and feature pages, while Whop ships a 3.3 MB photo and 1.5 MB PNGs.

## O que falta em encanto, em ordem de impacto no cliente

Owner key (assigned by Claude 4 in the channel on 06/11/2026; open PRs named): **Claude 2/5/6** for studio and store (buyer-facing store, product, thanks, studio); **Codex K2/T** for public marketing pages. Every unit is sized for one PR. Constraints for all units: AX274 AAA (7:1 text contrast, 3:1 components, motion only under `prefers-reduced-motion: no-preference`, nothing flashing, focus visible, 44 px targets); VR (no invented numbers, testimonials, logos or features; demo data labelled as demo); no "free" as a call to action; prices and limits unchanged; no overlay widgets; synthetic tests only.

| Rank | Screen(s) and evidence | Gap | Proposed change (one PR) | Queue item | Owner |
| --- | --- | --- | --- | --- | --- |
| 1 | Studio (not capturable); compare `whop-store-1440-viewport.png`, `whop-home-390-slow1s.png` | Creators wait on a blank or frozen studio; Whop shows skeletons on every list (8 on the store feed, 23 on home) | `loading.tsx` skeletons of the same size as the content for Today, Sales, Inbox and Products, with `aria-busy` and one hidden "Loading"; pulse only under `no-preference`, solid block under `reduce`; optimistic "mark read" and "archive" with Undo | 651 [WG11]; skeletons for studio home, inbox, library, product and course already in #2733 (open); left: Sales and Products lists, optimistic actions with Undo | Claude 6 |
| 2 | Thanks page and studio Today (not capturable) | No success moment after a confirmed purchase or a first sale | Draw-once check (600 ms, `nb-draw`) with "Payment received" in `role="status"` on the Stripe-confirmed thanks page; factual first-sale card in Today; static icon under `reduce`; never on unconfirmed orders | 654 [WG14] | Claude 2 |
| 3 | Store, `marktmorgen-store-1440-full.png` vs `whop-store-1440-viewport.png`, `whop-product-1440-viewport.png` | Desktop store is a single 540 px column with 900 px of empty sides; every card repeats about 90 words of consent and closing text | Two-column product grid at 1024 px and wider, store header (avatar, name, bio, Share) beside it; keep the consent text and checkbox byte-identical but render it once, inside the chosen product's buy step, directly above its Buy button (legal reviewer confirms placement still meets the withdrawal-waiver rule before merge) | none (store layout) | Claude 5 |
| 4 | Store, product, checkout entry, all public pages; `marktmorgen-store-390-dark-viewport.png` vs `whop-store-390-dark-viewport.png` | No dark scheme anywhere (0 `prefers-color-scheme: dark` rules); the AX274 open work in docs/accessibility-programme.md names dark themes; Whop stores follow the system | Dark tokens for the store theme (`--st-*`) first, each pair checked at 7:1 for text and 3:1 for controls, creator theme colors re-validated in dark; public pages in a second PR | dark mode complement | Claude 6 (store, after 651), Codex K2/T (public, after units 7, 8, 13, 14) |
| 5 | Store and product on slow network, `marktmorgen-store-390-slow4s.png`; product thumbnails | Photos paint over a flat beige box; product "More from" thumbnails are 1200×675 (116 to 202 kB) for a 56 px slot; slow-network LCP about 13 s | Generate a 16 px blurred placeholder or dominant color per product image at upload and paint it under the image; serve thumbnails at 2× their slot (112 px wide) via `srcset`/`sizes`; lazy-load everything below the first card | 651 [WG11] complement (perceived speed) | Claude 5 (after the store layout) |
| 6 | Home vs feature pages, `marktmorgen-home-1440-viewport.png` vs `marktmorgen-feature-1440-viewport.png` | Two visual languages in the main path: home and pricing use Unbounded/Figtree, navy/yellow and a yellow logo tile with a two-link header; /platform pages use Geist, indigo and a purple logo with full menus | Pick one system for all public pages (tokens, logo tile, header with the same menus on home), keep each page's copy; one PR for tokens and header, no content change | none | Codex K2/T, after units 7, 8, 9, 13 and 14 (needs one design decision first) |
| 7 | Home hero, `marktmorgen-home-1440-viewport.png` | Floating cards hide the phone mock's address ("…tmorgen.com/@yourname") and caption ("Preview with demo pro…") | Move the three cards so they overlap only the mock's edge and image area, never its text; at 1024 to 1280 px reduce card width; add a visual test that the mock's text boxes do not intersect the cards | none | Codex K2 |
| 8 | Home and pricing headers, pricing Store card | "Start free" is a call to action with "free", which the Encanto rules forbid | Change the buttons to "Start your store" (already used on /platform) or "Claim your name"; leave the factual sentence about trial days as text; no price or trial change | none | Codex K2 |
| 9 | Feature page, `marktmorgen-feature-1440-full.png` vs `whop-feature-1440-full.png` | 20 text cards and 0 images below the hero; Whop alternates text with product images | For the five most-used features, alternate sections with real screenshots of the demo store and a synthetic studio (labelled "Demo store" / "Example data"), WebP at display size, lazy below the fold, with full alt text; keep every honest section | 653 [WG13] complement (show the real modules) | Codex T (after 13) |
| 10 | Studio (not capturable); Whop docs "The Whop App Store" | Creators cannot see everything they can add in one place | "Add to your store" gallery with every real module and integration, state On/Off/Needs plan, each card opening the real editor | 653 [WG13], #2727 (open) | Claude 4 (#2727) |
| 11 | Store and studio lists; `whop-store-1440-viewport.png` (empty feed) | Empty lists lack one friendly sentence and one action | One sentence plus one button pattern for every list (store without products, posts, students), with a quiet static illustration; test fails when a list has no empty state | 656 [WG16], #2738 (open) | Claude 5 (#2738) |
| 12 | Product page, `whop-product-1440-full.png` | No visual rating summary when real reviews exist | When a product has verified reviews, show a star-count histogram and "Written N days after purchase" on each review, only from buyers verified by Stripe; nothing on the demo store until it has real reviews | none (extends verified reviews) | next Claude who is free |
| 13 | Pricing, `marktmorgen-pricing-390-full.png` (24,353 px) vs `whop-pricing-1440-full.png` | Very long on phone; no in-page index | Sticky section index (Plans, Allowances, Add-ons, Calculator, Questions) on desktop and a "Jump to" select on phone; group allowance tables under headings with a one-line summary each; every number stays visible on the page, values unchanged | none | Codex T |
| 14 | Home on phone, `marktmorgen-home-390-viewport.png` vs `whop-home-390-viewport.png` | The three-line "still being built" banner and header use about 200 px before the headline; the illustration starts below the fold | Keep the banner (VR) but shorten it to one line on phone ("Still being built. See what works today") with the same link; tighten header spacing so headline, field and button fit the first screen | none | Codex K2 |
| 15 | Store and public cards and buttons | Few hover and press responses; no transition between store and product | Under `no-preference` only: 150 ms lift and shadow on product cards, 100 ms press scale on buttons, and a cross-document View Transition from a store card to its product page; nothing under `reduce`, no looping motion | motion complement | Claude 2 (store, after 654), Codex K2/T (public, last) |

Not proposed, on purpose: Whop's video hero and customer-story videos (cost and AAA media duties: captions, transcript, audio description for every video), logo walls and "joined" counts (Marktmorgen has no real customers to show; VR), illustrative numbers like Whop's "Win back 240 members" (VR), and continuous marquees (AX274 2.2.2).

## Gaps in this comparison

- Checkout second screen: not captured on either site (Stripe-hosted after consent and form submission; Whop sign-in wall).
- Studio: not captured on either site (no account-free demo on Marktmorgen; Whop dashboard media on blocked mintcdn.com).
- Whop imagery on store, product and checkout pages, Mux videos and part of the home page: blocked hosts, so Whop looks plainer in these files than to real visitors, and its request and byte counts are lower bounds.
- Success screens and empty states inside both products: not observable without accounts.
- Measurements are one run each from one location through a proxy; they show order of magnitude, not a benchmark.
