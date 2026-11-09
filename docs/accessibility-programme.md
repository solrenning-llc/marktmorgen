# Marktmorgen accessibility and experience programme

> **MR vigente — dono27/10/2026 07h42 Fortaleza,464[MR1]:** [REGRA DE MARGEM](../AGENTS.md#mr--regra-de-margem-vigente-27-de-outubro-de-2026) substitui todos os pisos históricos de60% neste documento e suas referências. Exigir lucro líquido por unidade maior que zero no pior caso com a folga existente do spend floor,100% direitos mensal/anual e complementos; empresa sem prejuízo a partir de base mínima calculada com100%FX275 e exposições.60% é meta real mensal da empresa. Preservados ISS5%, leitura mais onerosa, recebimento mais caro, reservas/tetos/gates; desconhecido reprova, não é zero. Texto/citações/números antigos abaixo são histórico, não recalculados nem certificados. Código/relatório/regeneração pertencem a MR2; resultados atuais a MR3. Sem mudança de preços/limites/comissão/vendas.


The user's19 October2026 brief sets WCAG2.2 AAA as a starting point, plus practical
inclusion, cognitive clarity, usability, performance and reliability. It remains
a programme in progress, not a claim of whole-product conformance or superiority.
The original Path, customer-sales and60% net-margin goals and commercial gates
remain in force.

## Scope and evidence

The inventory lists125 page templates,284 shared TSX components,309 API route
sources,4 layouts and3 error/not-found/loading boundaries at its source revision. Dynamic
templates and integrations have many states; a listed source is not a tested
journey. A test guard detects added/missing sources so the scope cannot silently
shrink. Each group still needs appropriate manual and automated assessment.

First implementation: the shared secondary text greys and standard field
placeholder become darker. Muted text moves from 5.49:1 to 9.42:1 on ivory and
from 5.98:1 to 10.26:1 on white (W3C relative-luminance calculation). The selected
flat light palette has at least7.34:1 for muted text; tests hold both secondary
tokens above7.25:1. Standard placeholders use that grey with opacity1, avoiding
browser-default fading. This is narrow palette evidence, not all rendered text.

Browser tests use actual compiled styles on selected leaf secondary-text nodes,
with axe's colour-contrast-enhanced rule. They cover the existing390/1280
Funnels/Path flows, add320/768 layout checks, and check sign-in at320/390/768/1280
including its computed placeholder style. Existing AA,keyboard,manual refresh,
clipboard fallback and privacy browser tests remain. No real payment/email.

## Open work

Semantic/action colours, gradients, dark and creator-configured themes still need
context/size-aware enhanced-contrast review. The inventory records known palette
pairs below7:1 rather than treating them as passed. All page/process states,
zoom/text-spacing,orientation,keyboard/focus/drag alternatives,media,plain language,
errors/help and cognitive usability require broader review.

NVDA,JAWS,VoiceOver,TalkBack,all OS/browser combinations and sessions with people
with varied access needs have not been conducted here. Chromium automation is not
a screen-reader or human usability study. No benchmark against another product,
latency-percentile comparison or sales uplift is claimed. Performance needs
controlled representative tasks and network/device measurements.

## References reviewed19 October2026

- [WCAG2.2](https://www.w3.org/TR/WCAG22/) — full pages and complete processes matter.
- [Contrast enhanced](https://www.w3.org/WAI/WCAG22/Understanding/contrast-enhanced.html) —7:1 for normal text,with exceptions; colour math is not the whole standard.
- [WAI evaluation tools](https://www.w3.org/WAI/test-evaluate/tools/list/) — tool evidence informs the audit.
- [GOV.UK accessibility](https://design-system.service.gov.uk/accessibility/) — component reuse still requires service research/design/testing.
- [Microsoft Inclusive Design](https://inclusive.microsoft.design/) — diverse lived experiences inform practical inclusion.

Changes affect shared readability and test/documentation coverage only. No AI,
provider call,record,price,allowance or fiscal/commercial gate change.

## Standard field focus follow-up

Delivery19 strengthens standard field focus and measures actual Tab paint area,
including forced-colours emulation and synthetic invalid/readonly/select cases.
See docs/accessibility-field-focus.md. This partially addresses the standard
field focus entry; custom fields,all journeys/clipping and manual assistive/user
coverage remain open.

## Store fields and placeholder follow-up

Delivery20 gives store .st-field controls an opaque two-tone keyboard focus and
system outline in forced colours; scoped native-control screenshot checks use
the actual production palettes. See docs/accessibility-store-field-focus.md.

Delivery21 removes the faded creator-field placeholder and uses the theme's
primary text colour at full opacity. Computed pseudo-element and background
colours are measured in synthetic Chromium inputs for four themes/ten presets,
textareas on four theme cards with a custom accent,and four viewport widths.
The tests require7:1 after opacity compositing and confirm the example is
actually shown; a negative control must reject the former faded Night style.
Typing still replaces the example. Visible labels remain separate.

This fixes the shared style,not every buyer journey or custom override.
Read-only/disabled/error states,all browser/OS/assistive technology,real-user
research and whole-product AAA remain open. No sales uplift or margin proof
is inferred from this readability change.

## Sign-in error copy

Delivery22 separates light-surface error text from the brighter error-border
token. The actual sign-in inline format hint uses the darker text token;the
existing error notice uses the same value through the token. Border colours
and other red actions do not change. This is scoped evidence,not a wholesale
semantic-colour pass.

Synthetic browser cases at320/390/768/1280 trigger blur/invalid submit/empty
submit/correction. Enhanced-contrast axe checks must have actual passes,no
violations and no incomplete readings on the visible hint/alerts. Tests also
check field descriptions,invalid state,a single alert,correction cleanup and
zero login API requests. Requests are intercepted locally;no message is sent.
Other routes,colours,assistive technologies and user research remain open.

## Shared success copy
The shared light-surface live tag and success notice use a separate darker
success-text token on their existing mint surface. Existing mint action/border
tokens, messages, status behavior and all commercial controls are unchanged.
A palette guard requires7.25:1 reserve. Synthetic native samples in the real
built app at320/390/768/1280 use actual shared CSS and axe enhanced contrast,
with actual passes and no incomplete results. At390 a negative control must
reject both former colours, then the restored styles must pass again.
This is component-level evidence; it does not certify every rendered route,
custom override, screen reader or whole-product AAA.

## Store action keyboard focus
Primary and secondary store buttons and creator-profile links receive opaque
black/white keyboard rings independent of the creator's accent. In forced
colours the system Highlight outline remains and the shadow is removed.
Focus overrides promotional shadow animation only while keyboard-focused.
No action, destination, provider request or payment rule changes.

Actual compiled CSS is measured with real Tab and same-pixel before/after
screenshots using the existing3:1 area guard. Samples cover three action
classes across four themes/ten presets, Night at four widths, custom yellow
profile links on a light theme and forced-colours emulation. The former
2px accent-colour profile-link outline must fail on custom yellow, then the
restored style must pass. These are component samples, not all complete buyer
journeys, clipping contexts, screen readers or whole-product AAA certification.

## Path post-sale missions

The post-sale section adds one server-rendered component to the inventory. Its six factual mission states, native keyboard disclosures, own-store navigation, no manual completion inputs, 390/1280 layout and AA browser checks are covered by synthetic tests. The browser verification must pass before publication. This adds no screen-reader or whole-product AAA certification; actual assistive-technology work remains ordered Path item 15.

## Store muted text at 7:1 (1 November 2026)

Muted words on store pages (dates, notes, hints, "Unsaved" and similar) are small text, so WCAG 2.2 1.4.6 (AAA) asks 7:1. Measured with `contrast()` from `lib/store-look.ts`:

- **Before:** the "sand" theme's muted color `#5c5244` was 6.51:1 on its page and 6.92:1 on an item. Bands, which are tinted by the accent, were held to 4.5:1 for muted words only: 4.66:1 at worst on "night", 5.59:1 on "sand" and 6.75:1 on "light".
- **After:**
  - Sand's muted is `#4f4538`: 7.98:1 on the page, 9.22:1 on a card and 8.48:1 on an item.
  - A band must now give muted words 7:1. It only grows paler toward the card to pass, which always reaches it: the worst band is now 7.01:1.
  - The soft accent (behind chosen, selected and highlighted things) also gives muted words 7:1. On "night" it was 4.05–4.3:1.
  - `tests/page-style.test.ts` checks 7:1 on the page, on cards, on items, on bands and on the soft accent, in every theme and across every accent tested.
- **Not changed:**
  - Links on a band: decided on 2026-11-06 (C1-20261106-0100-TODOS-1) and built in 274 [AX1]: a link on a band is black or white, whichever reads more on it, always underlined (`lib/store-look.ts` `bandLink`, `app/globals.css`). `tests/band-link-contrast.test.ts` checks 7:1 for every theme across 216 accents (864 pairs). Before, links on a band were held to 4.5:1 in the creator's colour, which had no 7:1 solution for some accents; the creator's colour stays on buttons and elsewhere, not on band links.
  - Large text and non-text contrast were not changed.
  - Some backgrounds are barely set apart from the card. The soft accent on "night" moved from 1.60:1 to 1.30:1 against the card. Bands were already as close as 1.06:1 for some accents, before and after this change. Text stays readable on them, which is what 1.4.6 asks. A background difference is never the only sign that something is chosen (1.4.1), so a minimum band-to-card difference is a design choice left open.

## A video in a window: Escape inside the player (4 November 2026)

375 [TB1] unit 5 puts a creator's YouTube, Vimeo or Loom video in a modal `<dialog>` (`components/video-window.tsx`).

- **What works:** Escape closes the window when focus is on its Close button or on the frame element itself. Close and a click on the backdrop also close it. Each of these removes the player and returns focus to the button that opened it.
- **The case:** once the buyer clicks inside the player, or tabs into its own controls, keystrokes go to the player's document. That document is on the provider's origin, not ours. The browser does not pass Escape to our page, so the window stays open.
- **Demonstrated** by the independent review of #2135 in Chromium with a stand-in player that has its own buttons: Escape pressed inside it left the dialog open.
- **Why it cannot be fixed on our side:** a page cannot listen to keys inside a frame of another origin. Running our script in the frame is not possible either, because it is the provider's page.
- **The equivalent we offer:** this is not a keyboard trap (2.1.2). One Shift+Tab from the player's first control reaches Close, which is labeled "Close", is at least 44 × 44 px and is always visible at the top of the window. Close is also the first thing focused when the window opens.
- **Not checked:** a real screen reader with each provider's real player.

## Store front lines and the narrowest glyphs (7 November 2026)

WCAG 2.2 1.4.8 (AAA) asks that a block of text be no wider than 80 characters or glyphs. On a buyer's store front (`app/[handle]/page.tsx`), `app/globals.css` caps paragraphs, definitions, quotes, captions and the FAQ's questions at `34ch`. `tests/store-front-accessibility.test.ts` holds the cap.

The same cap holds the rest of the buyer's side of a store. On a store's product page (`app/[handle]/p/[product]/page.tsx`), its reviews page and a call's booking page, `app/globals.css` (`.st-measure`) caps paragraphs, definitions, quotes, captions, the lines of the description's lists and of what an option includes, the FAQ's questions, and the words of a block's benefits, fit lists, steps, contents and bonuses at `34ch`. Each is capped in its own font size, so a detail smaller than its title is held as well. Cards, rows and buttons (a review, "More from", a bundle's row, a call's length) are not capped as boxes, so they keep their width; their words are. `tests/product-page-accessibility.test.ts` holds the cap.

- **Measured** in Chromium 153 by `tests/e2e/store-front-audit.mjs`, which counts the characters actually on each rendered line. The run uses Geist for every store font, because the machine cannot reach Google Fonts.
  - **At 56ch (build of 06bca7d8d):** a real sentence reached 81 characters a line (the full store at 200%). Words made only of narrow letters (i, l, t, f, j, r, s) at each field's longest reached 126 a line at 1280 px; a question of 150 such characters reached 123.
  - **At 34ch** (the new rule laid over that same build, not a new build): real sentences reach at most 51 a line, and narrow-letter words at most 75, in the 18 cases of the full and edge stores. The one count over 80 is a card's row at 200%: a title of 79 characters (titles keep at most 80) and its price badge "$7", which is a separate box. A title is not a block of text.
- **Measured on the product page** in Chromium at 56ch, the cap before: the product page's real sentences reached at most 78 characters a line. Words made only of narrow letters (i, l, t, f, j, r, s) reached 126 a line on the store front above, in the same font (Geist). That count is a property of the font, not of the page.
  - **At 34ch, by arithmetic, not a new browser run:** a line holds the cap divided by its glyphs' width in `ch`, and `ch` follows each capped element's own font size. So the size does not change the count: narrow-letter words reach about 77 (126 × 34 ÷ 56) and real sentences about 47 (78 × 34 ÷ 56).
  - A question can be 200 characters (`MAX_QUESTION`), an item 200 (`MAX_ITEM`) and its detail 300 (`MAX_ITEM_DETAIL`); before, none of them was capped.
- **The case:** glyphs narrower than the cap allows for, 34ch ÷ 80 = 0.425ch each. Measured in Geist: an apostrophe is 0.268ch, a comma or period 0.303ch, "!" 0.321ch and "i" 0.368ch. A text of single letters and spaces ("i i i") averages 0.37ch. The spaces from U+2000 to U+200A are narrower still, and a combining mark takes no room of its own.
- **Why no width holds it:** a line holds the cap divided by the width of its glyphs. For any cap, a run of glyphs narrower than a 1/80 share of it goes past 80.
  - Holding 80 apostrophes would need a cap of 21ch. A real sentence would then keep about 30 characters a line in Geist (81 × 21 ÷ 56 on the store front, 78 × 21 ÷ 56 ≈ 29 on the product page).
  - Glyphs that take almost no room need a cap near zero.
  - So a CSS width that holds every glyph would cut ordinary sentences into short lines, and for the narrowest glyphs no width works. 34ch is the widest whole value that holds narrow-letter words with room (126 × 34 ÷ 56 ≈ 77). At 35ch the count would be about 79: no room left.
  - A script that measures each paragraph and narrows it to its own glyphs is not demonstrated impossible. It is not built: the store front and the product page are drawn on the server and must work without script.
- **The equivalent we offer:** the cap is in `ch`, so a line is the narrower of the cap and the window. Narrowing the window, or zooming in, narrows every line in the same proportion (WCAG technique C20). At 320 CSS px (400% zoom), the store front audit counted no line over 80 in any state. Reader views and the visitor's own style sheet also work, because the words are live text with no fixed width. The creator's words are never edited to fit.
- **Not checked:** other store fonts (Nunito, Fraunces, Playfair Display, Bricolage Grotesque, Instrument Serif) as actually served, Firefox and WebKit, real devices, people; the product page at 34ch in a browser.

## Gift form sent back with scripts off (9 November 2026)

WCAG 2.2 3.3.7 (Redundant Entry, A) asks that what a person already entered in the same process is filled in for them or selectable. The gift form on a product page (`GiftBox`, `components/store-product.tsx`) posts to `app/api/store/checkout/route.ts`. When the server refuses it (an address that is not one, an option, a busy unit, paused orders, a payment page Stripe would not open), it sends the buyer back to `?gift=<reason>#gift`, and the page is drawn anew. The form to buy for several people (`GroupBox`) works the same way: refused (a number of people, an option, buying for several people unavailable, paused orders, a payment page Stripe would not open), it sends the buyer back to `?group=<reason>#group`, and the same keeper, under its own key, keeps and puts back the option and how many people (`tests/group-error-a11y.test.ts`). Everything below holds for both forms: on the group form, a reason about how many people (a number that cannot be sold, or more than one payment can carry) or about the option marks that field the same way.

- **What works with scripts on:** `components/gift-typed-keeper.tsx` keeps the option, the recipient's address, the buyer's name and the message in the tab's own storage as the form is sent (`lib/gift-typed.ts`), puts them back into the fields that are still empty, then removes them. Nothing is sent to us. `tests/gift-error-a11y.test.ts` holds the rules.
- **The case:** with scripts off, the fields come back empty. The buyer types them again.
- **Not demonstrated impossible.** The route could answer the form with the page itself, filled from what was sent, instead of sending the buyer back to the product's address. It is not built: the route only redirects, and the product page is drawn from its address. The other ways were refused for privacy: the recipient's address and the message in the address bar would stay in the history and in logs, and keeping them on our server would send them to us.
- **The alternative we offer:** with scripts off the reason is still drawn by the server in the gift form, which opens by itself. A reason about one field marks that field `aria-invalid` and points to the words with `aria-describedby`; any other reason is the alert. The words say what to fix and that nothing was charged. The form is short: one required address, an option where there are several, the box to start access at once where the gift opens right away, and two optional fields.
- **Not checked:** a real screen reader, browsers other than through rendering tests, people.

## Resource-page interface captures (6 November 2026)

Encanto 9 adds dated captures to `/platform/store-page` and
`/platform/sales-pages`. These show the actual application with isolated,
fictional Harbor Kitchen content. They are not testimonials, customer outcomes,
or a replacement for the page's live heading, description, capability details,
and closed-plan notice. Captions identify the fictional content, capture date,
and substitute font. No text is placed over the captured pixels.

### SC 1.4.9 assessment and alternatives

The purpose is to show the interface arrangement: a creator profile above
product cards, and a product list beside an editor with Build/Preview tabs and
a page-coach panel. The surrounding card structure, spacing, selection and
control placement convey visual information in addition to the text. Rendering
a marketing paragraph as pixels is not this purpose. The capture's particular
presentation is the evidence of how the application looked at the recorded
revision; it does not establish the current state of a customer's store.

The [W3C explanation of SC 1.4.9](https://www.w3.org/WAI/WCAG22/Understanding/images-of-text-no-exception.html),
reviewed on November 6, 2026 (page updated September 16, 2025), distinguishes
screenshots conveying significant other visual information from an image that
simply styles text. Classification depends on what an individual image conveys,
not on its file extension or the word "screenshot". This is the scoped basis
for using these two informative interface captures; independent review must
confirm it before merge. It is not a blanket exemption for text in future images.

Each image has a specific text alternative describing its visible arrangement.
The store alternative identifies the profile, three product cards, titles and
price badges; the editor alternative identifies the product list, editor tabs
and page-coach score. The latter does not claim a phone preview outside the
captured area. Dates and provenance are live text in a visible `figcaption`.
Page explanations and availability remain live, adjustable HTML text; these
images introduce no separate product promise, price or testimonial.

### Evidence and remaining limits

Captures are 1280 by 820 pixels, with explicit intrinsic dimensions, lazy loading
and asynchronous decoding. Local static WebP assets are 37,746 and 54,842
bytes; the 100,000-byte per-capture publication ceiling was checked before
creating them. There is no optimizer, external image host or runtime capture.
The exact original SHA-256 digests are retained. Each matching resource page
requests one separately cacheable `/feature-captures/` asset; pixels are no
longer copied into the route module or HTML. The actual route dependency
graph measured with esbuild (packages external and the same substitute font)
fell from 1,769,389 to 1,645,958 bytes, and from 534,311 to 441,191 bytes gzip.
The capture module contributes 1,179 rather than 124,610 bytes. This is a
bundler report, not a Next production, RSC hydration, LCP or CLS measurement.
Static-hosting request/transfer costs remain existing company costs, unknown
rather than zero; these payload measurements do not certify global margin.
The source revision, timestamps and SHA-256 digests are recorded with the images.

The capture run used real Next server-rendered UI, local synthetic services and
a substitute font. JavaScript was disabled to avoid automatic visit analytics;
no hydration, editing interaction, production font fidelity or screen-reader
journey is claimed. Isolated component checks at 390 and 1440 pixels confirm
image decoding, readable live captions, no overflow and no violations in the
selected automated accessibility rules. Full page integration is checked in the
associated PR. Neither these checks nor this record certify whole-product AAA,
all access needs, real devices, LCP/CLS or production behavior. Review of the
image purpose and text alternatives remains part of independent PR review.
